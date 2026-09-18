/**
 * "Live" (P63d, refined P63e) — the ONE rule for whether a custom domain
 * actually serves the website, used by the customer read, the Platform
 * Owner list and overview, and the verification sweep's cadence.
 *
 * A production test showed why `connected` alone is not enough: Cloudflare
 * reported the custom hostname active (so Atlas said "connected"), and the
 * edge answered every visitor with a 525 — while the UI showed the domain
 * as live. The same test then showed why the PROVIDER's certificate state
 * is not the right second fact either: the customer's own Cloudflare zone
 * terminated TLS with its own trusted certificate and forwarded to Atlas,
 * so visitors had a working HTTPS site while Cloudflare for SaaS still
 * reported its own certificate as pending.
 *
 * What a visitor experiences is what Atlas's own probe measures — a TLS
 * handshake against a certificate Node trusts, plus a non-5xx answer — so
 * that is the rule:
 *
 *   live     = `status = connected` AND `httpsReachable = true`
 *
 * The provider's certificate state is reported alongside (`sslStatus`) as
 * an advisory: a live domain whose Atlas-managed certificate is still
 * pending depends on something outside Atlas (the customer's own proxy)
 * for its HTTPS, and the customer is told so. It is also why the sweep
 * keeps re-checking a live-but-unsettled domain on the fast cadence:
 *
 *   settled  = live AND `sslStatus = active`
 *
 * Pure so the API and the tests cannot disagree with each other.
 */
import type { DomainConnection } from '@prisma/client';

export type LivenessFacts = Pick<
  DomainConnection,
  'status' | 'sslStatus' | 'httpsReachable'
>;

/** The domain serves the website over HTTPS for visitors, as measured by Atlas's own probe. */
export function isCustomDomainLive(
  connection: LivenessFacts | null | undefined,
): boolean {
  return connection?.status === 'connected' && connection.httpsReachable === true;
}

/** Live AND the provider's own certificate is active: nothing left for the provider or the customer to do. */
export function isCustomDomainSettled(
  connection: LivenessFacts | null | undefined,
): boolean {
  return isCustomDomainLive(connection) && connection?.sslStatus === 'active';
}
