/**
 * The ONE rule for which base domain is in force (P63, shared P63g):
 * the deployment environment's `PLATFORM_BASE_DOMAIN` wins whenever set
 * (it is what CORS, public hostname resolution, the wildcard certificate
 * and DNS are actually configured for); otherwise the
 * `platform_domain_configuration` row, but only when it is marked
 * configured. Pure, so every writer of `full_host` and every reader of
 * the base domain (Academy creation, provisioning, availability, the
 * public runtime, readiness) agrees — before P63g three of them read the
 * raw database row and could advertise a host the platform did not serve.
 */
export type EffectiveBaseDomainSource = 'environment' | 'database';

export interface EffectiveBaseDomainResult {
  readonly baseDomain?: string;
  readonly source?: EffectiveBaseDomainSource;
}

export function resolveEffectiveBaseDomain(
  environmentValue: string | null | undefined,
  row:
    | { readonly baseDomain: string | null; readonly configured: boolean }
    | null
    | undefined,
): EffectiveBaseDomainResult {
  const env = environmentValue?.trim().toLowerCase();
  if (env) return { baseDomain: env, source: 'environment' };
  if (row?.configured && row.baseDomain) {
    return { baseDomain: row.baseDomain.trim().toLowerCase(), source: 'database' };
  }
  return {};
}

/** `{label}.{baseDomain}` when a base domain is in force; `null` (never a fabricated host) otherwise. */
export function buildFullHost(
  label: string,
  baseDomain: string | undefined,
): string | null {
  return baseDomain ? `${label.toLowerCase()}.${baseDomain}` : null;
}
