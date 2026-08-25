/**
 * Domain constants (master plan §21 Phase P11) — a field-for-field
 * backend reproduction of the real frontend's `domain.constants.ts`.
 */

/**
 * A standard, RFC-1035-shaped hostname: labels of 1–63 alphanumeric/
 * hyphen characters (never starting/ending with a hyphen), at least one
 * dot. Deliberately excludes a scheme/path/port — matches the frontend's
 * own `addCustomDomainSchema`/`platformDomainSchema` exactly.
 */
export const HOSTNAME_REGEX =
  /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

export const MAX_HOSTNAME_LENGTH = 253;
export const MIN_HOSTNAME_LENGTH = 4;

/** Matches `SubdomainStatus` (`provisioning.types.ts`) exactly. */
export const SUBDOMAIN_STATUS_VALUES = [
  'suggested',
  'available',
  'unavailable',
  'reserved',
  'assigned',
] as const;

/** Matches `DomainStatus` (`provisioning.types.ts`) exactly — the real 7-value enum. */
export const DOMAIN_STATUS_VALUES = [
  'not_configured',
  'pending',
  'verification_required',
  'verifying',
  'connected',
  'failed',
  'disconnected',
] as const;

/** Matches `SslStatus` (`domain.types.ts`) exactly. */
export const SSL_STATUS_VALUES = [
  'not_configured',
  'pending',
  'provisioning',
  'active',
  'failed',
  'expired',
] as const;

/** Matches `CdnStatus` (`domain.types.ts`) exactly. */
export const CDN_STATUS_VALUES = [
  'not_configured',
  'active',
  'degraded',
  'error',
] as const;

/** Matches `InfrastructureProviderName` (`domain.types.ts`) exactly. */
export const INFRASTRUCTURE_PROVIDER_NAMES = ['cloudflare'] as const;
