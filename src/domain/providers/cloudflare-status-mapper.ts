/**
 * Cloudflare → Atlas status mapping (master plan §21 P11: "map
 * provider-specific values into Atlas domain values... if Cloudflare
 * introduces a status the frontend contract does not define, do NOT
 * silently map it to 'connected'"). Pure functions — no HTTP, no
 * database, deterministic — so the precedence/mapping is directly
 * unit-testable with real Cloudflare API response fixtures, independent
 * of `CloudflareApiProvider`'s network code.
 *
 * Cloudflare's real "Custom Hostname" status vocabulary (`active`,
 * `pending`, `active_redeploying`, `moved`, `pending_deletion`,
 * `deleted`, `pending_blocked`, `pending_migration`,
 * `pending_provisioned`, `test_pending`, `test_active`,
 * `test_active_apex`, `test_blocked`, `test_failed`, `provisioned`,
 * `blocked`) and SSL sub-status vocabulary (`initializing`,
 * `pending_validation`, `pending_issuance`, `pending_deployment`,
 * `active`, `expired`, `deleted`, and several more timeout/deactivating
 * variants) are both far wider than Atlas's own narrow enums — every
 * mapping below is a deliberate, documented, safe collapse, never an
 * assumption that an unrecognized value means success.
 */
import type { CloudflareCustomHostname } from './cloudflare-provider.interface';
import type { CdnStatus, DomainStatus, SslStatus } from '@prisma/client';

/** Cloudflare custom-hostname `status` → Atlas `DomainStatus`. Anything genuinely unrecognized falls to `failed` — the safest state that still surfaces a real problem to the Academy Owner, never a silent `connected`. */
export function mapCloudflareHostnameStatus(cloudflareStatus: string): DomainStatus {
  switch (cloudflareStatus) {
    case 'active':
    case 'active_redeploying':
    case 'test_active':
    case 'test_active_apex':
      return 'connected';
    case 'pending':
    case 'pending_migration':
    case 'pending_provisioned':
    case 'test_pending':
    case 'provisioned':
      return 'verifying';
    case 'pending_deletion':
    case 'deleted':
      return 'disconnected';
    case 'pending_blocked':
    case 'blocked':
    case 'test_blocked':
    case 'test_failed':
    case 'moved':
      return 'failed';
    default:
      return 'failed';
  }
}

/** Cloudflare SSL sub-status → Atlas `SslStatus`. */
export function mapCloudflareSslStatus(cloudflareSslStatus: string): SslStatus {
  switch (cloudflareSslStatus) {
    case 'active':
    case 'staging_active':
      return 'active';
    case 'initializing':
    case 'pending_validation':
    case 'pending_cleanup':
      return 'pending';
    case 'pending_issuance':
    case 'pending_deployment':
    case 'staging_deployment':
      return 'provisioning';
    case 'expired':
      return 'expired';
    case 'deleted':
    case 'pending_deletion':
    case 'pending_expiration':
    case 'inactive':
    case 'backup_issued':
    case 'holding_deployment':
      return 'not_configured';
    case 'initializing_timed_out':
    case 'validation_timed_out':
    case 'issuance_timed_out':
    case 'deployment_timed_out':
    case 'deletion_timed_out':
    case 'deactivating':
      return 'failed';
    default:
      return 'failed';
  }
}

/**
 * CDN/proxy status is derived from the SAME custom-hostname check —
 * Cloudflare's Custom Hostnames for SaaS feature has no separate,
 * independently-queryable "CDN status" API distinct from the hostname's
 * own connection state (a custom hostname active on a Cloudflare zone is,
 * by construction, already served through Cloudflare's edge/CDN). This is
 * a deliberate, documented simplification, not a fabricated extra check:
 * `active` domain status ⇒ CDN `active`; a domain still connecting ⇒ CDN
 * `not_configured` (nothing to degrade yet); a failed/blocked hostname ⇒
 * CDN `error`.
 */
export function mapCloudflareCdnStatus(domainStatus: DomainStatus): CdnStatus {
  switch (domainStatus) {
    case 'connected':
      return 'active';
    case 'failed':
      return 'error';
    default:
      return 'not_configured';
  }
}

export interface MappedDomainState {
  readonly status: DomainStatus;
  readonly sslStatus: SslStatus;
  readonly cdnStatus: CdnStatus;
}

/** Composes all three mappers over one real Cloudflare custom-hostname response — the one place a caller needs to call to get a fully mapped Atlas state. */
export function mapCloudflareCustomHostname(
  hostname: CloudflareCustomHostname,
): MappedDomainState {
  const status = mapCloudflareHostnameStatus(hostname.status);
  return {
    status,
    sslStatus: mapCloudflareSslStatus(hostname.sslStatus),
    cdnStatus: mapCloudflareCdnStatus(status),
  };
}
