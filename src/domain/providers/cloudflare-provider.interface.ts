/**
 * CloudflareProvider — the provider-abstraction boundary the master plan
 * asks for (§21 P11: "Do NOT scatter Cloudflare HTTP calls throughout
 * controllers... Create a dedicated provider adapter/service"). Every raw
 * Cloudflare REST API v4 call lives behind this interface; no controller
 * or service outside `src/domain/providers/` ever issues one directly.
 *
 * Returns RAW, un-mapped Cloudflare response fields (`status`/`sslStatus`
 * are Cloudflare's own vocabulary, not Atlas's) — mapping into Atlas's
 * `DomainStatus`/`SslStatus`/`CdnStatus` enums happens exclusively in
 * `cloudflare-status-mapper.ts`, kept as pure, deterministic, fixture-
 * testable functions with no HTTP dependency of their own.
 *
 * P63 adds the two READ-ONLY zone facts a custom domain genuinely depends
 * on and that Atlas previously could not tell anyone about: the
 * Cloudflare-for-SaaS fallback origin (the CNAME target a customer must
 * point their hostname at — without it "verification" can never complete)
 * and the zone's origin SSL mode (Caddy answers custom hostnames with an
 * internal certificate, which `strict` refuses).
 */

import type { ProviderErrorCategory } from '../constants/domain.constants';

export interface CloudflareVerificationRecord {
  readonly type: string;
  readonly name: string;
  readonly value: string;
}

/** A Cloudflare "Custom Hostname" (SaaS for Cloudflare) resource — the real primitive behind connecting an Academy's custom domain to Atlas's zone. */
export interface CloudflareCustomHostname {
  readonly id: string;
  readonly hostname: string;
  /** Cloudflare's own custom-hostname status vocabulary (e.g. `'pending'`/`'active'`/`'blocked'`) — never assumed to match Atlas's `DomainStatus`. */
  readonly status: string;
  /** Cloudflare's own SSL sub-status vocabulary (e.g. `'pending_validation'`/`'active'`) — never assumed to match Atlas's `SslStatus`. */
  readonly sslStatus: string;
  readonly verificationRecords: readonly CloudflareVerificationRecord[];
  /** Cloudflare's own human-readable verification errors, when it reports any (e.g. a CNAME that does not point at the zone). Display data only; never a secret. */
  readonly verificationErrors?: readonly string[];
}

/** The zone's Cloudflare-for-SaaS fallback origin — the hostname every custom hostname is routed to, and therefore the CNAME target customers must use. */
export interface CloudflareFallbackOrigin {
  readonly origin: string;
  /** Cloudflare's own vocabulary (`active`, `pending_deployment`, …). */
  readonly status: string;
}

/**
 * P63c — a provider refusal Atlas can classify and record safely: the
 * provider's own numeric code and a coarse category. Deliberately carries
 * no provider message (those can quote zone names, plans or tokens).
 */
export class CloudflareProviderError extends Error {
  constructor(
    readonly code: number | null,
    readonly category: ProviderErrorCategory,
  ) {
    super(`cloudflare:${category}:${code ?? 'none'}`);
    this.name = 'CloudflareProviderError';
  }
}

/** The last refusal seen while reading zone facts (fallback origin / SSL mode), for the Platform Owner readiness view. */
export interface CloudflareZoneFactsError {
  readonly code: number | null;
  readonly category: ProviderErrorCategory;
}

export const CLOUDFLARE_PROVIDER = Symbol('CLOUDFLARE_PROVIDER');

export interface CloudflareProvider {
  /** Whether the configured API token is genuinely valid — a real, minimal round trip (`GET /user/tokens/verify`), never assumed from credential presence alone. Returns `false` (never throws) when no credentials are configured at all. */
  verifyToken(): Promise<boolean>;

  /**
   * Creates a Cloudflare Custom Hostname for `hostname` under the
   * configured zone — the real "connect a custom domain" operation.
   * IDEMPOTENT (P63): when Cloudflare already holds this hostname in the
   * zone, the existing resource is returned rather than an error, so a
   * repeated submission never loses the verification records.
   * Throws `CloudflareProviderError` (code + category, no message) when
   * the provider refuses; any other error means the request itself failed.
   */
  createCustomHostname(hostname: string): Promise<CloudflareCustomHostname>;

  /** Looks up an existing Custom Hostname by its hostname value — the real "check current status" / "re-verify" operation. `null` if none exists for this hostname in the configured zone. */
  getCustomHostnameByHostname(hostname: string): Promise<CloudflareCustomHostname | null>;

  /** Looks up a Custom Hostname by the provider's own id. `null` when it no longer exists. */
  getCustomHostnameById(id: string): Promise<CloudflareCustomHostname | null>;

  /** Deletes a Custom Hostname — the real "disconnect" operation. */
  deleteCustomHostname(id: string): Promise<void>;

  /** The zone's fallback origin, or `null` when none is configured or the provider is unavailable. Read-only. */
  getFallbackOrigin(): Promise<CloudflareFallbackOrigin | null>;

  /** The zone's origin SSL mode (`off` / `flexible` / `full` / `strict`), or `null` when unavailable. Read-only. */
  getZoneSslMode(): Promise<string | null>;

  /** Why the last zone-facts read was refused, if it was; `null` after a successful read. */
  getLastZoneFactsError(): CloudflareZoneFactsError | null;
}
