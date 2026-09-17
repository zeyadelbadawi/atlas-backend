/**
 * FakeCloudflareProvider (P63) — an in-memory `CloudflareProvider` for e2e
 * specs. It is NOT a mock that returns whatever it is told per call: it
 * keeps real state (the hostnames "the zone" holds, each with a status the
 * test advances), so the service under test behaves exactly as it would
 * against Cloudflare while the test controls what Cloudflare would say.
 */
import {
  CloudflareProviderError,
  type CloudflareCustomHostname,
  type CloudflareFallbackOrigin,
  type CloudflareProvider,
  type CloudflareZoneFactsError,
} from '../../src/domain/providers/cloudflare-provider.interface';

interface FakeHostnameState {
  readonly id: string;
  readonly hostname: string;
  status: string;
  sslStatus: string;
  verificationErrors: string[];
}

export class FakeCloudflareProvider implements CloudflareProvider {
  connected = true;
  fallbackOrigin: CloudflareFallbackOrigin | null = {
    origin: 'customers.atlas-test.dev',
    status: 'active',
  };
  zoneSslMode: string | null = 'full';
  /** When set, every hostname request throws — simulates a provider outage AFTER the token check passed. */
  outage = false;
  /** When set, registration is REFUSED with this code/category (e.g. a token without custom-hostname permissions) while lookups still work. */
  registrationRefusal: {
    code: number;
    category: 'permission' | 'not_enabled' | 'unknown';
  } | null = null;
  zoneFactsError: CloudflareZoneFactsError | null = null;
  readonly calls: string[] = [];
  private readonly hostnames = new Map<string, FakeHostnameState>();
  private sequence = 0;

  reset(): void {
    this.connected = true;
    this.outage = false;
    this.registrationRefusal = null;
    this.zoneFactsError = null;
    this.fallbackOrigin = { origin: 'customers.atlas-test.dev', status: 'active' };
    this.hostnames.clear();
    this.calls.length = 0;
  }

  private guard(): void {
    if (this.outage) throw new Error('fake cloudflare outage');
  }

  private toResource(state: FakeHostnameState): CloudflareCustomHostname {
    return {
      id: state.id,
      hostname: state.hostname,
      status: state.status,
      sslStatus: state.sslStatus,
      verificationRecords: [
        {
          type: 'txt',
          name: `_cf-custom-hostname.${state.hostname}`,
          value: `own-${state.id}`,
        },
        {
          type: 'TXT',
          name: `_acme-challenge.${state.hostname}`,
          value: `ssl-${state.id}`,
        },
      ],
      verificationErrors: [...state.verificationErrors],
    };
  }

  /** Test control: pretend Cloudflare observed the customer's DNS and moved the hostname on. */
  setState(
    hostname: string,
    status: string,
    sslStatus: string,
    verificationErrors: string[] = [],
  ): void {
    const state = this.hostnames.get(hostname);
    if (!state) throw new Error(`fake cloudflare: unknown hostname ${hostname}`);
    state.status = status;
    state.sslStatus = sslStatus;
    state.verificationErrors = verificationErrors;
  }

  /** Test control: pretend the hostname vanished from the zone (deleted out-of-band). */
  forget(hostname: string): void {
    this.hostnames.delete(hostname);
  }

  has(hostname: string): boolean {
    return this.hostnames.has(hostname);
  }

  async verifyToken(): Promise<boolean> {
    this.calls.push('verifyToken');
    return this.connected;
  }

  async createCustomHostname(hostname: string): Promise<CloudflareCustomHostname> {
    this.calls.push(`create:${hostname}`);
    this.guard();
    const existing = this.hostnames.get(hostname);
    if (existing) return this.toResource(existing);
    if (this.registrationRefusal) {
      throw new CloudflareProviderError(
        this.registrationRefusal.code,
        this.registrationRefusal.category,
      );
    }
    this.sequence += 1;
    const state: FakeHostnameState = {
      id: `cfh_${this.sequence}`,
      hostname,
      status: 'pending',
      sslStatus: 'pending_validation',
      verificationErrors: [],
    };
    this.hostnames.set(hostname, state);
    return this.toResource(state);
  }

  async getCustomHostnameByHostname(
    hostname: string,
  ): Promise<CloudflareCustomHostname | null> {
    this.calls.push(`getByHostname:${hostname}`);
    this.guard();
    const state = this.hostnames.get(hostname);
    return state ? this.toResource(state) : null;
  }

  async getCustomHostnameById(id: string): Promise<CloudflareCustomHostname | null> {
    this.calls.push(`getById:${id}`);
    this.guard();
    for (const state of this.hostnames.values())
      if (state.id === id) return this.toResource(state);
    return null;
  }

  async deleteCustomHostname(id: string): Promise<void> {
    this.calls.push(`delete:${id}`);
    this.guard();
    for (const [hostname, state] of this.hostnames)
      if (state.id === id) this.hostnames.delete(hostname);
  }

  async getFallbackOrigin(): Promise<CloudflareFallbackOrigin | null> {
    this.calls.push('fallbackOrigin');
    if (this.outage) return null;
    return this.fallbackOrigin;
  }

  getLastZoneFactsError(): CloudflareZoneFactsError | null {
    return this.zoneFactsError;
  }

  async getZoneSslMode(): Promise<string | null> {
    this.calls.push('sslMode');
    if (this.outage) return null;
    return this.zoneSslMode;
  }
}
