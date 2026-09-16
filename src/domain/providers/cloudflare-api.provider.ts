/**
 * CloudflareApiProvider — the REAL Cloudflare REST API v4 client (master
 * plan §21 P11: "not a mock... not a placeholder"). Every method issues a
 * genuine authenticated HTTP request to `https://api.cloudflare.com/client/v4`
 * using Node's built-in `fetch` (Node 20+, this repo's minimum engine —
 * no new HTTP client dependency introduced).
 *
 * Uses the real "Custom Hostnames for Cloudflare for SaaS" API surface —
 * the genuine Cloudflare primitive for "let a customer point their own
 * domain at our zone, with Cloudflare managing SSL for it," which is
 * exactly the `AddCustomDomainPayload`/`verifyDomain` capability the real
 * frontend contract expects.
 *
 * Credentials come exclusively from `CloudflareConfig`
 * (`ConfigService.get('cloudflare')`, itself sourced from
 * `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ZONE_ID`) — never hardcoded, never
 * logged (see every catch block below: only the HTTP status and
 * Cloudflare's own `errors[].message` array are logged, never headers or
 * the raw request). No credential or raw Cloudflare response body ever
 * reaches a thrown exception message that could propagate to an HTTP
 * response — callers only ever see `not_configured`/a mapped Atlas status
 * or a generic `errors.domain.providerUnavailable`.
 *
 * P63: every request now carries a bounded timeout (a hung provider must
 * never hang a customer's "check now" or the verification sweep), and
 * `createCustomHostname` is idempotent against Cloudflare's own duplicate
 * rejection.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CloudflareConfig } from '../../config/configuration';
import type {
  CloudflareCustomHostname,
  CloudflareFallbackOrigin,
  CloudflareProvider,
  CloudflareVerificationRecord,
} from './cloudflare-provider.interface';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
const REQUEST_TIMEOUT_MS = 10_000;

interface CloudflareApiError {
  readonly code: number;
  readonly message: string;
}

interface CloudflareApiEnvelope<T> {
  readonly success: boolean;
  readonly errors: readonly CloudflareApiError[];
  readonly result: T | null;
}

interface CloudflareCustomHostnameRaw {
  readonly id: string;
  readonly hostname: string;
  readonly status: string;
  readonly verification_errors?: readonly string[];
  readonly ownership_verification?: {
    readonly type: string;
    readonly name: string;
    readonly value: string;
  };
  readonly ssl?: {
    readonly status: string;
    readonly validation_errors?: readonly { readonly message?: string }[];
    readonly validation_records?: readonly {
      readonly txt_name?: string;
      readonly txt_value?: string;
      readonly http_url?: string;
      readonly http_body?: string;
    }[];
  };
}

interface CloudflareFallbackOriginRaw {
  readonly origin?: string | null;
  readonly status?: string;
}

function toVerificationRecords(
  raw: CloudflareCustomHostnameRaw,
): CloudflareVerificationRecord[] {
  const records: CloudflareVerificationRecord[] = [];
  if (raw.ownership_verification) {
    records.push({
      type: raw.ownership_verification.type,
      name: raw.ownership_verification.name,
      value: raw.ownership_verification.value,
    });
  }
  for (const record of raw.ssl?.validation_records ?? []) {
    if (record.txt_name && record.txt_value) {
      records.push({ type: 'TXT', name: record.txt_name, value: record.txt_value });
    } else if (record.http_url && record.http_body) {
      records.push({ type: 'HTTP', name: record.http_url, value: record.http_body });
    }
  }
  return records;
}

function toCustomHostname(raw: CloudflareCustomHostnameRaw): CloudflareCustomHostname {
  return {
    id: raw.id,
    hostname: raw.hostname,
    status: raw.status,
    sslStatus: raw.ssl?.status ?? 'initializing',
    verificationRecords: toVerificationRecords(raw),
    verificationErrors: [
      ...(raw.verification_errors ?? []),
      ...(raw.ssl?.validation_errors ?? [])
        .map((error) => error.message)
        .filter((message): message is string => typeof message === 'string'),
    ],
  };
}

@Injectable()
export class CloudflareApiProvider implements CloudflareProvider {
  private readonly logger = new Logger(CloudflareApiProvider.name);
  private readonly config: CloudflareConfig;

  constructor(configService: ConfigService) {
    this.config = configService.get<CloudflareConfig>('cloudflare') ?? {};
  }

  private isConfigured(): boolean {
    return !!(this.config.apiToken && this.config.zoneId);
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<CloudflareApiEnvelope<T>> {
    const response = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
    const body = (await response.json()) as CloudflareApiEnvelope<T>;
    return body;
  }

  private warn(message: string, error: unknown): void {
    this.logger.warn(
      { error: error instanceof Error ? error.message : 'unknown' },
      message,
    );
  }

  async verifyToken(): Promise<boolean> {
    if (!this.config.apiToken) return false;
    try {
      const body = await this.request<{ status: string }>('/user/tokens/verify');
      return body.success && body.result?.status === 'active';
    } catch (error) {
      this.warn('Cloudflare token verification failed', error);
      return false;
    }
  }

  async createCustomHostname(hostname: string): Promise<CloudflareCustomHostname> {
    if (!this.isConfigured()) {
      throw new Error('Cloudflare is not configured');
    }
    const body = await this.request<CloudflareCustomHostnameRaw>(
      `/zones/${this.config.zoneId}/custom_hostnames`,
      {
        method: 'POST',
        body: JSON.stringify({
          hostname,
          ssl: { method: 'txt', type: 'dv' },
        }),
      },
    );
    if (body.success && body.result) return toCustomHostname(body.result);

    // Cloudflare refuses a hostname the zone already holds. That is not a
    // failure of the customer's intent — the resource they need exists —
    // so return it instead of losing its verification records.
    const existing = await this.getCustomHostnameByHostname(hostname);
    if (existing) return existing;

    this.logger.warn(
      { errors: body.errors?.map((e) => e.message) },
      'Cloudflare custom hostname creation failed',
    );
    throw new Error('Cloudflare custom hostname creation failed');
  }

  async getCustomHostnameByHostname(
    hostname: string,
  ): Promise<CloudflareCustomHostname | null> {
    if (!this.isConfigured()) return null;
    const body = await this.request<CloudflareCustomHostnameRaw[]>(
      `/zones/${this.config.zoneId}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`,
    );
    if (!body.success || !body.result || body.result.length === 0) return null;
    return toCustomHostname(body.result[0]);
  }

  async getCustomHostnameById(id: string): Promise<CloudflareCustomHostname | null> {
    if (!this.isConfigured()) return null;
    const body = await this.request<CloudflareCustomHostnameRaw>(
      `/zones/${this.config.zoneId}/custom_hostnames/${encodeURIComponent(id)}`,
    );
    if (!body.success || !body.result) return null;
    return toCustomHostname(body.result);
  }

  async deleteCustomHostname(id: string): Promise<void> {
    if (!this.isConfigured()) return;
    const body = await this.request<{ id: string }>(
      `/zones/${this.config.zoneId}/custom_hostnames/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    if (!body.success) {
      this.logger.warn(
        { errors: body.errors?.map((e) => e.message) },
        'Cloudflare custom hostname deletion failed',
      );
    }
  }

  async getFallbackOrigin(): Promise<CloudflareFallbackOrigin | null> {
    if (!this.isConfigured()) return null;
    try {
      const body = await this.request<CloudflareFallbackOriginRaw>(
        `/zones/${this.config.zoneId}/custom_hostnames/fallback_origin`,
      );
      if (!body.success || !body.result?.origin) return null;
      return { origin: body.result.origin, status: body.result.status ?? 'unknown' };
    } catch (error) {
      this.warn('Cloudflare fallback origin lookup failed', error);
      return null;
    }
  }

  async getZoneSslMode(): Promise<string | null> {
    if (!this.isConfigured()) return null;
    try {
      const body = await this.request<{ value?: string }>(
        `/zones/${this.config.zoneId}/settings/ssl`,
      );
      if (!body.success || !body.result?.value) return null;
      return body.result.value;
    } catch (error) {
      this.warn('Cloudflare zone SSL mode lookup failed', error);
      return null;
    }
  }
}
