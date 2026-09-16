/**
 * Platform Owner domain operations contracts (P63) — one row per Academy,
 * because every Academy has exactly one website address story: an Atlas
 * subdomain, optionally a custom domain, and one canonical host.
 */
import type { AcademyStatus } from '@prisma/client';
import type {
  CanonicalHostResponse,
  DomainConnectionResponse,
  SubdomainAllocationResponse,
} from './domain.contract';
import {
  toDomainConnectionResponse,
  toSubdomainAllocationResponse,
} from './domain.contract';
import type {
  AcademyDomainRow,
  DomainOperationsOverview,
} from '../repositories/domain-connections.repository';
import { DOMAIN_STATUSES_NEEDING_ATTENTION } from '../repositories/domain-connections.repository';
import { resolveCanonicalHost } from '../utils/canonical-host.util';

export interface PlatformDomainRowResponse {
  readonly academyId: string;
  readonly academyName: string;
  readonly academySlug: string;
  readonly academyStatus: AcademyStatus;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly subdomain?: SubdomainAllocationResponse;
  readonly customDomain?: DomainConnectionResponse;
  readonly canonicalHost?: CanonicalHostResponse;
  /** Derived from stored facts only: attention-worthy status, a recorded check error, or a failed HTTPS probe. */
  readonly needsAttention: boolean;
  readonly createdAt: string;
}

export interface PlatformDomainsOverviewResponse extends DomainOperationsOverview {
  readonly checkedAt: string;
}

export function needsAttention(row: AcademyDomainRow): boolean {
  const dc = row.domainConnection;
  if (!dc?.hostname) return false;
  return (
    DOMAIN_STATUSES_NEEDING_ATTENTION.includes(dc.status) ||
    dc.lastCheckError !== null ||
    dc.httpsReachable === false
  );
}

export function toPlatformDomainRowResponse(
  row: AcademyDomainRow,
  baseDomain: string | undefined,
): PlatformDomainRowResponse {
  const canonical = resolveCanonicalHost({
    connectedCustomHostname:
      row.domainConnection?.status === 'connected' ? row.domainConnection.hostname : null,
    customHttpsReachable: row.domainConnection?.httpsReachable,
    subdomainFullHost: row.subdomainAllocation?.fullHost,
    subdomainLabel: row.subdomainAllocation?.subdomain,
    baseDomain,
  });
  return {
    academyId: row.id,
    academyName: row.name,
    academySlug: row.slug,
    academyStatus: row.status,
    organizationId: row.organizationId,
    organizationName: row.organization.name,
    subdomain: toSubdomainAllocationResponse(row.subdomainAllocation),
    customDomain: toDomainConnectionResponse(row.domainConnection),
    canonicalHost: canonical ?? undefined,
    needsAttention: needsAttention(row),
    createdAt: row.createdAt.toISOString(),
  };
}
