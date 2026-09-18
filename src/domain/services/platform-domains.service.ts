/**
 * PlatformDomainsService (P63) — the Platform Owner's operational view of
 * every customer's website address, and the operator's "check now".
 *
 * Every read runs under `runInUserContext(platformOwnerId)` with no
 * organization variable set, so only the `_platform_select` policies can
 * match — a non-owner reaching this code sees nothing, not another
 * tenant's domain. The operator check writes through the P63
 * `domain_connections_platform_update` policy and is audited with the
 * operator as the actor.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { PublicWebsiteCacheService } from '../../public-website/services/public-website-cache.service';
import { DomainConnectionsRepository } from '../repositories/domain-connections.repository';
import { DomainCheckService } from './domain-check.service';
import { DomainService } from './domain.service';
import { DomainProviderReleaseService } from './domain-provider-release.service';
import { DomainProviderReleasesRepository } from '../repositories/domain-provider-releases.repository';
import { PlatformDomainService } from './platform-domain.service';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import {
  buildPaginationMeta,
  type PaginatedResult,
} from '../../common/dto/pagination.contract';
import type { PlatformDomainsQueryDto } from '../dto/platform-domains-query.dto';
import {
  toPlatformDomainRowResponse,
  type PlatformDomainRowResponse,
  type PlatformDomainsOverviewResponse,
} from '../dto/platform-domains.contract';
import { DOMAIN_AUDIT_ACTIONS } from '../constants/domain.constants';
import { resolveSubdomainHost } from '../utils/canonical-host.util';

@Injectable()
export class PlatformDomainsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly domainConnectionsRepository: DomainConnectionsRepository,
    private readonly domainCheckService: DomainCheckService,
    private readonly domainService: DomainService,
    private readonly releaseService: DomainProviderReleaseService,
    private readonly releasesRepository: DomainProviderReleasesRepository,
    private readonly platformDomainService: PlatformDomainService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly publicWebsiteCacheService: PublicWebsiteCacheService,
  ) {}

  /**
   * P63g — operator release: frees a hostname an Academy is holding
   * (typically archived, or a customer who left without disconnecting)
   * so its rightful owner can connect it elsewhere. Same reset as the
   * customer's Disconnect, through the platform UPDATE policy, audited
   * with the operator as actor; the provider resource is released after
   * commit and retried by the sweep if that fails.
   */
  async release(
    platformOwnerId: string,
    academyId: string,
  ): Promise<PlatformDomainRowResponse> {
    const { row, previousHostname, releaseId, subdomain } =
      await this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
        const existing = await this.domainConnectionsRepository.lockByAcademyId(
          tx,
          academyId,
        );
        if (!existing?.hostname) {
          throw new NotFoundException({ messageKey: 'errors.domain.noCustomDomain' });
        }
        const academy =
          await this.domainConnectionsRepository.findAcademyWithDomainsAnyOrganization(
            tx,
            academyId,
          );
        if (!academy) throw new NotFoundException({ messageKey: 'errors.notFound' });

        const reset = await this.domainService.resetInTransaction(
          tx,
          academyId,
          existing,
          'operator_release',
        );
        await this.auditLogWriterService.write(tx, {
          actorUserId: platformOwnerId,
          organizationId: academy.organizationId,
          academyId,
          role: 'platform_owner',
          action: DOMAIN_AUDIT_ACTIONS.platformRelease,
          targetType: 'domain_connection',
          targetId: reset.row.id,
          targetLabel: existing.hostname,
          changes: {
            hostname: { from: existing.hostname, to: null },
            status: { from: existing.status, to: 'not_configured' },
          },
        });
        const refreshed =
          await this.domainConnectionsRepository.findAcademyWithDomainsAnyOrganization(
            tx,
            academyId,
          );
        return {
          row: refreshed!,
          previousHostname: existing.hostname,
          releaseId: reset.releaseId,
          subdomain: refreshed!.subdomainAllocation,
        };
      });

    const { baseDomain } = await this.platformDomainService.getEffectiveBaseDomain();
    const full = resolveSubdomainHost({
      subdomainFullHost: subdomain?.fullHost,
      subdomainLabel: subdomain?.subdomain,
      baseDomain,
    });
    await this.publicWebsiteCacheService.invalidateHostnameResolution(
      [previousHostname, subdomain?.subdomain, full].filter((h): h is string =>
        Boolean(h),
      ),
    );
    if (releaseId) {
      try {
        const providerAvailable = await this.platformDomainService.isProviderAvailable();
        await this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
          const release = await this.releasesRepository.findById(tx, releaseId);
          if (release) await this.releaseService.attempt(tx, release, providerAvailable);
        });
      } catch {
        // The sweep retries it.
      }
    }
    return toPlatformDomainRowResponse(row, baseDomain);
  }

  async list(
    platformOwnerId: string,
    query: PlatformDomainsQueryDto,
  ): Promise<PaginatedResult<PlatformDomainRowResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const [{ items, totalItems }, { baseDomain }] = await Promise.all([
      this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
        this.domainConnectionsRepository.findManyAcademiesWithDomains(tx, {
          search: query.search,
          kind: query.kind,
          status: query.status,
          attention: query.attention,
          sortBy: query.sortBy,
          sortDirection: query.sortDirection,
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
      ),
      this.platformDomainService.getEffectiveBaseDomain(),
    ]);

    return {
      items: items.map((row) => toPlatformDomainRowResponse(row, baseDomain)),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  async overview(platformOwnerId: string): Promise<PlatformDomainsOverviewResponse> {
    const counts = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      (tx) => this.domainConnectionsRepository.countOperationsOverview(tx),
    );
    return { ...counts, checkedAt: new Date().toISOString() };
  }

  async get(
    platformOwnerId: string,
    academyId: string,
  ): Promise<PlatformDomainRowResponse> {
    const [row, { baseDomain }] = await Promise.all([
      this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
        this.domainConnectionsRepository.findAcademyWithDomainsAnyOrganization(
          tx,
          academyId,
        ),
      ),
      this.platformDomainService.getEffectiveBaseDomain(),
    ]);
    if (!row) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return toPlatformDomainRowResponse(row, baseDomain);
  }

  /** Operator-triggered re-check: same `DomainCheckService`, same row lock, audited with the operator as actor. */
  async check(
    platformOwnerId: string,
    academyId: string,
  ): Promise<PlatformDomainRowResponse> {
    const { row, statusChanged } = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      async (tx) => {
        const existing = await this.domainConnectionsRepository.lockByAcademyId(
          tx,
          academyId,
        );
        if (!existing?.hostname) {
          throw new NotFoundException({ messageKey: 'errors.domain.noCustomDomain' });
        }
        const academy =
          await this.domainConnectionsRepository.findAcademyWithDomainsAnyOrganization(
            tx,
            academyId,
          );
        if (!academy) throw new NotFoundException({ messageKey: 'errors.notFound' });

        const outcome = await this.domainCheckService.check(tx, existing);

        await this.auditLogWriterService.write(tx, {
          actorUserId: platformOwnerId,
          organizationId: academy.organizationId,
          academyId,
          role: 'platform_owner',
          action: DOMAIN_AUDIT_ACTIONS.platformCheck,
          targetType: 'domain_connection',
          targetId: outcome.after.id,
          targetLabel: existing.hostname,
          context: {
            outcome: outcome.error ? 'failed' : 'succeeded',
            error: outcome.error,
            httpsReachable: outcome.after.httpsReachable ?? null,
          },
          changes: {
            status: { from: outcome.before.status, to: outcome.after.status },
            sslStatus: { from: outcome.before.sslStatus, to: outcome.after.sslStatus },
          },
        });

        const refreshed =
          await this.domainConnectionsRepository.findAcademyWithDomainsAnyOrganization(
            tx,
            academyId,
          );
        return { row: refreshed!, statusChanged: outcome.canonicalMayHaveChanged };
      },
    );

    const { baseDomain } = await this.platformDomainService.getEffectiveBaseDomain();
    if (statusChanged) {
      const hosts = [row.domainConnection?.hostname, row.subdomainAllocation?.subdomain];
      const full = resolveSubdomainHost({
        subdomainFullHost: row.subdomainAllocation?.fullHost,
        subdomainLabel: row.subdomainAllocation?.subdomain,
        baseDomain,
      });
      await this.publicWebsiteCacheService.invalidateHostnameResolution(
        [...hosts, full].filter((h): h is string => Boolean(h)),
      );
    }
    return toPlatformDomainRowResponse(row, baseDomain);
  }
}
