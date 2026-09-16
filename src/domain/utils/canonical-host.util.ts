/**
 * Canonical host resolution (P63).
 *
 * An Academy may be reachable on two hosts at once — its Atlas subdomain
 * (`{slug}.{baseDomain}`) and a connected custom domain. Both stay live
 * (a customer's DNS can break; the Atlas host is the safety net), but
 * exactly ONE is canonical: the address the public website advertises in
 * `<link rel="canonical">`, the address the dashboard shows as "your
 * website address", and the address a visitor on the other host is sent
 * to.
 *
 * THE RULE: a custom domain the customer connected, Atlas verified as
 * `connected`, and Atlas's own HTTPS probe has not found unreachable,
 * wins; otherwise the Atlas subdomain. There is deliberately
 * no stored "primary domain" preference — a customer who went through DNS
 * verification did so precisely to use that address, and a preference
 * that could point at an unverified or failed hostname would send real
 * visitors to a dead site. If a genuine product need for the reverse
 * choice ever appears, it belongs here, server-side, not in React.
 *
 * Pure and deterministic so it is unit-testable and so the public runtime
 * (`resolve_public_hostname` result), the tenant read and the Platform
 * Owner list cannot disagree.
 */

export interface CanonicalHostInput {
  /** `domain_connections.hostname` when — and only when — `status = 'connected'`. */
  readonly connectedCustomHostname: string | null | undefined;
  /**
   * The custom domain's last HTTPS probe. `false` (known unreachable)
   * demotes it: a canonical host that does not answer would turn the
   * Atlas subdomain — the safety net — into a redirect to a dead site.
   * `undefined`/`null` (never probed) does not demote.
   */
  readonly customHttpsReachable?: boolean | null;
  /** `subdomain_allocations.full_host` (already `{label}.{baseDomain}`), when assigned. */
  readonly subdomainFullHost: string | null | undefined;
  /** Fallback when the allocation carries no `full_host` (no base domain was configured at allocation time). */
  readonly subdomainLabel: string | null | undefined;
  readonly baseDomain: string | null | undefined;
}

export type CanonicalHostSource = 'custom_domain' | 'subdomain';

export interface CanonicalHost {
  readonly host: string;
  readonly source: CanonicalHostSource;
}

/** The Atlas-provided host for an Academy, or `null` when no base domain is known — never a fabricated host. */
export function resolveSubdomainHost(
  input: Pick<CanonicalHostInput, 'subdomainFullHost' | 'subdomainLabel' | 'baseDomain'>,
): string | null {
  if (input.subdomainFullHost) return input.subdomainFullHost.toLowerCase();
  if (input.subdomainLabel && input.baseDomain) {
    return `${input.subdomainLabel}.${input.baseDomain}`.toLowerCase();
  }
  return null;
}

export function resolveCanonicalHost(input: CanonicalHostInput): CanonicalHost | null {
  if (input.connectedCustomHostname && input.customHttpsReachable !== false) {
    return { host: input.connectedCustomHostname.toLowerCase(), source: 'custom_domain' };
  }
  const subdomainHost = resolveSubdomainHost(input);
  return subdomainHost ? { host: subdomainHost, source: 'subdomain' } : null;
}
