/**
 * "Live" (P63d) — the ONE rule for whether a custom domain actually serves
 * the website, used by the customer read, the Platform Owner list and
 * overview, and the verification sweep's cadence.
 *
 * A production test showed why `connected` alone is not enough: Cloudflare
 * reported the custom hostname active (so Atlas said "connected"), its
 * certificate was still pending, and the edge answered every visitor with
 * a 525 — while the UI showed the domain as live. Three independent facts
 * must all hold, and each is recorded from a different source:
 *
 *   1. `status = connected`     — the provider says the hostname is active
 *                                 at its edge (DNS ownership verified,
 *                                 hostname provisioned);
 *   2. `sslStatus = active`     — the provider says the edge certificate
 *                                 for the hostname is issued and deployed;
 *   3. `httpsReachable = true`  — Atlas's own probe completed a TLS
 *                                 handshake AND got a non-5xx answer.
 *
 * Anything less is an intermediate state the UI must name, never "live".
 * Pure so the API and the tests cannot disagree with each other.
 */
import type { DomainConnection } from '@prisma/client';

export type LivenessFacts = Pick<
  DomainConnection,
  'status' | 'sslStatus' | 'httpsReachable'
>;

export function isCustomDomainLive(
  connection: LivenessFacts | null | undefined,
): boolean {
  return (
    connection?.status === 'connected' &&
    connection.sslStatus === 'active' &&
    connection.httpsReachable === true
  );
}
