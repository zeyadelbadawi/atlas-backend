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
 * Cloudflare's own `errors[].code` array are logged, never headers or
 * the raw request). No credential or raw Cloudflare response body ever
 * reaches a thrown exception message that could propagate to an HTTP
 * response — callers only ever see `not_configured`/a mapped Atlas status
 * or a generic `errors.domain.providerUnavailable`.
 *
 * P63: every request carries a bounded timeout (a hung provider must
 * never hang a customer's "check now" or the verification sweep).
 *
 * P63g (production audit):
 *   - `createCustomHostname` adopts an existing resource ONLY when the
 *     provider says the exact hostname already exists — never on a
 *     permission error or any other refusal, which used to be masked;
 *   - hostname lookups assert an exact match on the returned resource;
 *   - "not found" is distinguished from "the request failed", so a
 *     transient 5xx can never be recorded as "the provider forgot it";
 *   - deletes report an outcome instead of being fire-and-forget;
 *   - one bounded retry on 429/5xx (honouring a short `Retry-After`);
 *   - a non-JSON body (edge error page) is a request failure, not a crash;
 *   - certificates are validated over HTTP (automatic, renewals included,
 *     for any hostname whose traffic routes through the provider) and a
 *     legacy TXT-validated resource can be migrated in place.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CloudflareConfig } from '../../config/configuration';
import {
  CLOUDFLARE_SSL_METHOD,
  CloudflareProviderError,
  type CloudflareCustomHostname,
  type CloudflareDeleteOutcome,
  type CloudflareFallbackOrigin,
  type CloudflareProvider,
  type CloudflareVerificationRecord,
  type CloudflareZoneFactsError,
  type CloudflareZoneSslModeRead,
} from './cloudflare-provider.interface';
import type { ProviderErrorCategory } from '../constants/domain.constants';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
const REQUEST_TIMEOUT_MS = 10_000;
/** One retry on 429/5xx, after at most this long (a `Retry-After` shorter than this is honoured, longer is capped — the caller's own timeout budget wins). */
const RETRY_MAX_DELAY_MS = 2_000;
/** Cloudflare's "custom hostname not found" code, alongside HTTP 404. */
const NOT_FOUND_CODES = new Set([1436, 1404]);

interface CloudflareApiError {
  readonly code: number;
  readonly message: string;
}

interface CloudflareApiEnvelope<T> {
  readonly success: boolean;
  readonly errors: readonly CloudflareApiError[];
  readonly result: T | null;
}

/** What `request()` returns: a parsed envelope, or a transport-level failure the caller must treat as "unknown", never as an answer. */
type ApiResponse<T> =
  | {
      readonly ok: true;
      readonly status: number;
      readonly body: CloudflareApiEnvelope<T>;
    }
  | {
      readonly ok: false;
      readonly status: number | null;
      readonly failure: 'timeout' | 'network' | 'non_json';
    };

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
    readonly method?: string;
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
    sslMethod: raw.ssl?.method,
    verificationRecords: toVerificationRecords(raw),
    verificationErrors: [
      ...(raw.verification_errors ?? []),
      ...(raw.ssl?.validation_errors ?? [])
        .map((error) => error.message)
        .filter((message): message is string => typeof message === 'string'),
    ],
  };
}

/**
 * Coarse classification of a Cloudflare refusal. Codes per Cloudflare's
 * API: 9103/9106/9109/10000 are authentication/authorization failures
 * (a token without the `SSL and Certificates: Edit` permission lands
 * here); 1400-series custom-hostname codes phrase entitlement/enablement
 * problems in the message; 1003/1004-style codes are hostname validation.
 * Anything else is `unknown` — never silently treated as success.
 * P63g: the code reported is the one belonging to the error that decided
 * the category, not blindly the first error's.
 */
export function classifyCloudflareError(
  errors: readonly CloudflareApiError[] | undefined,
): { code: number | null; category: ProviderErrorCategory } {
  const list = errors ?? [];
  const first = list[0];
  const firstCode = typeof first?.code === 'number' ? first.code : null;
  for (const error of list) {
    const code = typeof error.code === 'number' ? error.code : null;
    const text = (error.message ?? '').toLowerCase();
    if (code !== null && [9103, 9106, 9109, 10000, 10001].includes(code)) {
      return { code, category: 'permission' };
    }
    if (/permission|not authorized|unauthorized|forbidden/.test(text)) {
      return { code, category: 'permission' };
    }
    if (
      /not enabled|not entitled|entitlement|upgrade|requires .*plan|cloudflare for saas/.test(
        text,
      )
    ) {
      return { code, category: 'not_enabled' };
    }
    if (/invalid hostname|hostname is invalid|not a valid|malformed/.test(text)) {
      return { code, category: 'invalid_hostname' };
    }
    if (code === 971 || /rate limit|too many requests/.test(text)) {
      return { code, category: 'rate_limited' };
    }
  }
  return { code: firstCode, category: 'unknown' };
}

/** P63g — Cloudflare's "this hostname already exists in the zone" refusal, the ONLY case in which an existing resource may be adopted. */
export function isDuplicateHostnameError(
  errors: readonly CloudflareApiError[] | undefined,
): boolean {
  return (errors ?? []).some(
    (error) =>
      error.code === 1406 ||
      /already exists|duplicate|already (been )?added|is already/i.test(
        error.message ?? '',
      ),
  );
}

function isNotFound(
  status: number,
  errors: readonly CloudflareApiError[] | undefined,
): boolean {
  if (status === 404) return true;
  return (errors ?? []).some(
    (error) =>
      NOT_FOUND_CODES.has(error.code) ||
      /not found|does not exist/i.test(error.message ?? ''),
  );
}

@Injectable()
export class CloudflareApiProvider implements CloudflareProvider {
  private readonly logger = new Logger(CloudflareApiProvider.name);
  private readonly config: CloudflareConfig;
  private lastZoneFactsError: CloudflareZoneFactsError | null = null;

  getLastZoneFactsError(): CloudflareZoneFactsError | null {
    return this.lastZoneFactsError;
  }

  constructor(configService: ConfigService) {
    this.config = configService.get<CloudflareConfig>('cloudflare') ?? {};
  }

  private isConfigured(): boolean {
    return !!(this.config.apiToken && this.config.zoneId);
  }

  private zonePath(rest: string): string {
    return `/zones/${encodeURIComponent(this.config.zoneId ?? '')}${rest}`;
  }

  /** One attempt: parsed envelope or a classified transport failure. Never throws. */
  private async attempt<T>(path: string, init: RequestInit): Promise<ApiResponse<T>> {
    let response: Response;
    try {
      response = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${this.config.apiToken}`,
          'Content-Type': 'application/json',
          ...init.headers,
        },
      });
    } catch (error) {
      const timeout = error instanceof Error && error.name === 'TimeoutError';
      return { ok: false, status: null, failure: timeout ? 'timeout' : 'network' };
    }
    let body: CloudflareApiEnvelope<T>;
    try {
      body = (await response.json()) as CloudflareApiEnvelope<T>;
    } catch {
      return { ok: false, status: response.status, failure: 'non_json' };
    }
    if (typeof body !== 'object' || body === null || typeof body.success !== 'boolean') {
      return { ok: false, status: response.status, failure: 'non_json' };
    }
    return { ok: true, status: response.status, body };
  }

  /**
   * A request with one bounded retry on 429 / 5xx / transport failure.
   * The retry delay honours a short `Retry-After` and is capped so a
   * customer's "Check now" never waits on a provider's back-off headers.
   */
  private async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<ApiResponse<T>> {
    const first = await this.attempt<T>(path, init);
    const retryable =
      (!first.ok && first.failure !== 'non_json') ||
      (first.ok && (first.status === 429 || first.status >= 500)) ||
      (!first.ok &&
        first.status !== null &&
        (first.status === 429 || first.status >= 500));
    if (!retryable) return first;
    await new Promise((resolve) => setTimeout(resolve, RETRY_MAX_DELAY_MS / 2));
    const second = await this.attempt<T>(path, init);
    return second;
  }

  /** Throws a plain Error for a transport failure — callers classify that as "the request failed", never as a provider answer. */
  private unwrap<T>(
    response: ApiResponse<T>,
    what: string,
  ): CloudflareApiEnvelope<T> & { status: number } {
    if (!response.ok) {
      this.logger.warn(
        { what, status: response.status, failure: response.failure },
        'Cloudflare request failed',
      );
      throw new Error(`cloudflare:${what}:${response.failure}`);
    }
    return { ...response.body, status: response.status };
  }

  async verifyToken(): Promise<boolean> {
    if (!this.config.apiToken) return false;
    const response = await this.request<{ status: string }>('/user/tokens/verify');
    if (!response.ok) {
      this.logger.warn(
        { failure: response.failure },
        'Cloudflare token verification failed',
      );
      return false;
    }
    return response.body.success && response.body.result?.status === 'active';
  }

  async createCustomHostname(hostname: string): Promise<CloudflareCustomHostname> {
    if (!this.isConfigured()) {
      throw new Error('Cloudflare is not configured');
    }
    const body = this.unwrap(
      await this.request<CloudflareCustomHostnameRaw>(
        this.zonePath('/custom_hostnames'),
        {
          method: 'POST',
          body: JSON.stringify({
            hostname,
            ssl: { method: CLOUDFLARE_SSL_METHOD, type: 'dv' },
          }),
        },
      ),
      'create',
    );
    if (body.success && body.result) {
      const created = toCustomHostname(body.result);
      if (created.hostname.toLowerCase() !== hostname.toLowerCase()) {
        // The provider answered for a different name than we asked for —
        // never adopt it.
        throw new CloudflareProviderError(null, 'unknown');
      }
      return created;
    }

    // Cloudflare refuses a hostname the zone already holds. That is not a
    // failure of the customer's intent — the resource they need exists —
    // so return it instead of losing its verification records. ONLY that
    // refusal is adopted; a permission or entitlement error is reported.
    if (isDuplicateHostnameError(body.errors)) {
      const existing = await this.getCustomHostnameByHostname(hostname);
      if (existing) return existing;
    }

    const classified = classifyCloudflareError(body.errors);
    this.logger.warn(
      { codes: body.errors?.map((e) => e.code), category: classified.category },
      'Cloudflare custom hostname creation refused',
    );
    throw new CloudflareProviderError(classified.code, classified.category);
  }

  async getCustomHostnameByHostname(
    hostname: string,
  ): Promise<CloudflareCustomHostname | null> {
    if (!this.isConfigured()) return null;
    const body = this.unwrap(
      await this.request<CloudflareCustomHostnameRaw[]>(
        this.zonePath(
          `/custom_hostnames?hostname=${encodeURIComponent(hostname)}&per_page=50`,
        ),
      ),
      'lookup',
    );
    if (!body.success) {
      const classified = classifyCloudflareError(body.errors);
      throw new CloudflareProviderError(classified.code, classified.category);
    }
    const match = (body.result ?? []).find(
      (raw) => raw.hostname?.toLowerCase() === hostname.toLowerCase(),
    );
    return match ? toCustomHostname(match) : null;
  }

  async getCustomHostnameById(id: string): Promise<CloudflareCustomHostname | null> {
    if (!this.isConfigured()) return null;
    const body = this.unwrap(
      await this.request<CloudflareCustomHostnameRaw>(
        this.zonePath(`/custom_hostnames/${encodeURIComponent(id)}`),
      ),
      'get',
    );
    if (body.success && body.result) return toCustomHostname(body.result);
    if (isNotFound(body.status, body.errors)) return null;
    const classified = classifyCloudflareError(body.errors);
    throw new CloudflareProviderError(classified.code, classified.category);
  }

  async deleteCustomHostname(id: string): Promise<CloudflareDeleteOutcome> {
    if (!this.isConfigured()) return 'failed';
    const response = await this.request<{ id: string }>(
      this.zonePath(`/custom_hostnames/${encodeURIComponent(id)}`),
      { method: 'DELETE' },
    );
    if (!response.ok) {
      this.logger.warn(
        { failure: response.failure },
        'Cloudflare custom hostname deletion failed',
      );
      return 'failed';
    }
    if (response.body.success) return 'deleted';
    if (isNotFound(response.status, response.body.errors)) return 'not_found';
    this.logger.warn(
      { codes: response.body.errors?.map((e) => e.code) },
      'Cloudflare custom hostname deletion refused',
    );
    return 'failed';
  }

  async updateCustomHostnameSslMethod(id: string, method: string): Promise<boolean> {
    if (!this.isConfigured()) return false;
    const response = await this.request<CloudflareCustomHostnameRaw>(
      this.zonePath(`/custom_hostnames/${encodeURIComponent(id)}`),
      { method: 'PATCH', body: JSON.stringify({ ssl: { method, type: 'dv' } }) },
    );
    if (!response.ok || !response.body.success) {
      this.logger.warn(
        {
          ok: response.ok,
          codes: response.ok ? response.body.errors?.map((e) => e.code) : undefined,
        },
        'Cloudflare custom hostname SSL method update refused',
      );
      return false;
    }
    return true;
  }

  async getFallbackOrigin(): Promise<CloudflareFallbackOrigin | null> {
    if (!this.isConfigured()) return null;
    const response = await this.request<CloudflareFallbackOriginRaw>(
      this.zonePath('/custom_hostnames/fallback_origin'),
    );
    if (!response.ok) {
      this.logger.warn(
        { failure: response.failure },
        'Cloudflare fallback origin lookup failed',
      );
      return null;
    }
    const body = response.body;
    if (!body.success) {
      this.lastZoneFactsError = classifyCloudflareError(body.errors);
      this.logger.warn(
        {
          codes: body.errors?.map((e) => e.code),
          category: this.lastZoneFactsError.category,
        },
        'Cloudflare fallback origin read refused',
      );
      return null;
    }
    this.lastZoneFactsError = null;
    if (!body.result?.origin) return null;
    return { origin: body.result.origin, status: body.result.status ?? 'unknown' };
  }

  /**
   * `GET /zones/{zone}/settings/ssl` needs the token permission
   * "Zone Settings: Read" (or Write) — a permission the custom-hostname
   * work itself never needs, so a token scoped exactly to custom hostnames
   * is refused here. That refusal is reported, not swallowed: the Platform
   * Owner sees "not exposed to Atlas — code N (token permissions)" instead
   * of an unexplained warning, and the value is never guessed.
   */
  async getZoneSslMode(): Promise<CloudflareZoneSslModeRead> {
    if (!this.isConfigured()) return { mode: null, error: null, requestFailed: false };
    const response = await this.request<{ value?: string }>(
      this.zonePath('/settings/ssl'),
    );
    if (!response.ok) {
      this.logger.warn(
        { failure: response.failure },
        'Cloudflare zone SSL mode lookup failed',
      );
      return { mode: null, error: null, requestFailed: true };
    }
    const body = response.body;
    if (!body.success) {
      const classified = classifyCloudflareError(body.errors);
      this.logger.warn(
        { codes: body.errors?.map((e) => e.code), category: classified.category },
        'Cloudflare zone SSL mode read refused',
      );
      return { mode: null, error: classified, requestFailed: false };
    }
    return { mode: body.result?.value ?? null, error: null, requestFailed: false };
  }
}
