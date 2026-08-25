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
 */

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
}

export const CLOUDFLARE_PROVIDER = Symbol('CLOUDFLARE_PROVIDER');

export interface CloudflareProvider {
  /** Whether the configured API token is genuinely valid — a real, minimal round trip (`GET /user/tokens/verify`), never assumed from credential presence alone. Returns `false` (never throws) when no credentials are configured at all. */
  verifyToken(): Promise<boolean>;

  /** Creates a new Cloudflare Custom Hostname for `hostname` under the configured zone — the real "connect a custom domain" operation. */
  createCustomHostname(hostname: string): Promise<CloudflareCustomHostname>;

  /** Looks up an existing Custom Hostname by its hostname value — the real "check current status" / "re-verify" operation. `null` if none exists for this hostname in the configured zone. */
  getCustomHostnameByHostname(hostname: string): Promise<CloudflareCustomHostname | null>;

  /** Deletes a Custom Hostname — the real "disconnect" operation. */
  deleteCustomHostname(id: string): Promise<void>;
}
