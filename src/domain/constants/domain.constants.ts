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

/** P63 — a hostname must not be an IPv4 literal (the hostname regex alone admits dotted quads). */
export const NOT_IP_LITERAL_REGEX = /^(?!(\d{1,3}\.){3}\d{1,3}$)/;

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

/**
 * P63 — stable, non-sensitive codes for `domain_connections.last_check_error`.
 * The frontend maps each to copy in both languages; a raw provider
 * message is never stored or shown.
 */
export const DOMAIN_CHECK_ERROR_CODES = [
  /** No valid provider credentials — Atlas could not ask anyone. */
  'provider_unavailable',
  /** The provider holds no record of this hostname (never accepted, or since deleted). */
  'provider_hostname_missing',
  /** The provider request itself failed (network, 5xx, timeout). */
  'provider_error',
  /** The provider reports the hostname's DNS does not point at Atlas yet. */
  'dns_not_pointing',
] as const;
export type DomainCheckErrorCode = (typeof DOMAIN_CHECK_ERROR_CODES)[number];

/** Audit actions written by the domain capability (P63). */
export const DOMAIN_AUDIT_ACTIONS = {
  customDomainAdded: 'domain.custom_domain_added',
  customDomainRemoved: 'domain.custom_domain_removed',
  verificationChecked: 'domain.verification_checked',
  platformCheck: 'domain.platform_check',
} as const;
