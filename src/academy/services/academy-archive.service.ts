/**
 * AcademyArchiveService — the ONE implementation of "this academy is now
 * archived", shared by every path that archives one (D5-2).
 *
 * WHY IT EXISTS. There are two such paths: the owner deleting an academy
 * (`AcademiesService.archive`, `DELETE /academies/:id`) and account
 * deletion archiving every academy of the organizations the person owns
 * (`AccountDeletionService`). Until D5-2 the second one was a bare
 * `status = 'archived'` update. It never recorded `archivedAt`, so
 * `ArchivedMediaPurgeService` — which keys the 30-day grace on exactly that
 * column — could never purge those academies' media; it never released the
 * custom domain, so the hostname stayed burned and the provider resource
 * kept answering at the edge; and it never dropped the cached hostname
 * resolution or recomputed usage. Two copies of "archive" had drifted, and
 * the one that fell behind was the one used least.
 *
 * The pieces are split by transaction, not by caller, because the two
 * callers hold different transactions:
 *   - `markArchived` — the state itself, inside the caller's transaction;
 *   - `releaseCustomDomain` — the domain ledger + connection reset, inside
 *     a TENANT-AND-USER transaction (the connection is invisible to a
 *     tenant-only read);
 *   - `afterArchiveCommitted` — cache drop, provider release attempt and
 *     usage recompute, once everything above has committed.
 *
 * LIVES IN ITS OWN MODULE (`AcademyArchiveModule`) so `IdentityModule` can
 * use it: `AcademyModule` imports `IdentityModule`, so the reverse import
 * would be a cycle. Everything it injects is a stateless wrapper over
 * global services, registered directly there for the same reason
 * `AcademyModule` registers its domain providers directly.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { Academy } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { TenantUsageRecomputeProducer } from '../../plans/queue/tenant-usage-recompute.producer';
import { SubdomainAllocationsRepository } from '../../domain/repositories/subdomain-allocations.repository';
import { DomainConnectionsRepository } from '../../domain/repositories/domain-connections.repository';
import { DomainProviderReleasesRepository } from '../../domain/repositories/domain-provider-releases.repository';
import { DomainProviderReleaseService } from '../../domain/services/domain-provider-release.service';
import { PlatformDomainService } from '../../domain/services/platform-domain.service';
import { PlatformDomainConfigurationRepository } from '../../domain/repositories/platform-domain-configuration.repository';
import { PublicWebsiteCacheService } from '../../public-website/services/public-website-cache.service';
import {
  buildFullHost,
  resolveEffectiveBaseDomain,
} from '../../domain/utils/effective-base-domain.util';
import type { PlatformDomainRuntimeConfig } from '../../config/configuration';
import type { AcademyArchiveReason } from '../dto/delete-academy.dto';

/**
 * What the caller may record when deleting an Academy. Both fields are
 * optional: deletion must never depend on answering an exit survey.
 */
export interface ArchiveAcademyInput {
  readonly reason?: AcademyArchiveReason;
  readonly feedback?: string;
}

/** What `releaseCustomDomain` found and freed, carried to `afterArchiveCommitted`. */
export interface ArchivedAcademyPresence {
  readonly slug: string;
  readonly allocation: {
    readonly subdomain: string;
    readonly fullHost: string | null;
  } | null;
  /** The custom hostname that was connected, now released. */
  readonly previousHostname: string | null;
  /** The `domain_provider_releases` row to attempt once committed. */
  readonly releaseId: string | null;
}

@Injectable()
export class AcademyArchiveService {
  private readonly environmentBaseDomain?: string;

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly usersRepository: UsersRepository,
    private readonly tenantUsageRecomputeProducer: TenantUsageRecomputeProducer,
    private readonly subdomainAllocationsRepository: SubdomainAllocationsRepository,
    private readonly platformDomainConfigurationRepository: PlatformDomainConfigurationRepository,
    private readonly domainConnectionsRepository: DomainConnectionsRepository,
    private readonly domainProviderReleasesRepository: DomainProviderReleasesRepository,
    private readonly domainProviderReleaseService: DomainProviderReleaseService,
    private readonly platformDomainService: PlatformDomainService,
    private readonly publicWebsiteCacheService: PublicWebsiteCacheService,
    configService: ConfigService,
  ) {
    this.environmentBaseDomain = configService
      .get<PlatformDomainRuntimeConfig>('platformDomain')
      ?.baseDomain?.trim()
      .toLowerCase();
  }

  /**
   * The archived STATE, inside the caller's transaction and tenant
   * context. `archivedAt` is what starts the 30-day media grace
   * (`ArchivedMediaPurgeService`); every archive writes it, or that
   * academy's media is never purged.
   */
  markArchived(
    tx: Prisma.TransactionClient,
    academyId: string,
    input: ArchiveAcademyInput = {},
    archivedAt: Date = new Date(),
  ): Promise<Academy> {
    return tx.academy.update({
      where: { id: academyId },
      data: {
        status: 'archived',
        archivedAt,
        archiveReason: input.reason ?? null,
        archiveFeedback: input.feedback?.trim() || null,
      },
    });
  }

  /**
   * Frees the academy's custom domain (P63g): enqueues the provider
   * release on the `domain_provider_releases` ledger and resets the
   * connection, so the hostname is claimable again. Must run inside a
   * tenant-AND-user transaction — the connection is invisible to a
   * tenant-only read. Returns what `afterArchiveCommitted` needs.
   */
  async releaseCustomDomain(
    tx: Prisma.TransactionClient,
    academy: { readonly id: string; readonly slug: string },
  ): Promise<ArchivedAcademyPresence> {
    const allocation = await this.subdomainAllocationsRepository.findByAcademyId(
      tx,
      academy.id,
    );
    const connection = await this.domainConnectionsRepository.lockByAcademyId(
      tx,
      academy.id,
    );
    let releaseId: string | null = null;
    if (connection?.hostname) {
      const release = await this.domainProviderReleasesRepository.enqueue(tx, {
        academyId: academy.id,
        hostname: connection.hostname,
        providerHostnameId: connection.providerHostnameId,
        reason: 'archived',
      });
      releaseId = release.id;
      await this.domainConnectionsRepository.updateByAcademyId(tx, academy.id, {
        hostname: null,
        status: 'not_configured',
        verificationRecords: Prisma.JsonNull,
        sslStatus: 'not_configured',
        cdnStatus: 'not_configured',
        cdnProvider: null,
        providerHostnameId: null,
        connectedAt: null,
        lastCheckedAt: null,
        lastCheckError: null,
        lastProviderErrorCode: null,
        httpsReachable: null,
        httpsCheckedAt: null,
        httpsStatusCode: null,
        httpsFailureReason: null,
        consecutiveFailures: 0,
      });
    }
    return {
      slug: academy.slug,
      allocation,
      previousHostname: connection?.hostname ?? null,
      releaseId,
    };
  }

  /**
   * Everything that follows a COMMITTED archive, for one organization's
   * academies:
   *
   *   - every cached hostname resolution is dropped, so the public site
   *     goes offline within the request rather than after the 60 s TTL
   *     (`resolve_public_hostname` already refuses archived academies);
   *   - the provider release is attempted (best-effort; the sweep retries
   *     anything that fails — never throws);
   *   - the organization's usage is recomputed once, which is what frees
   *     the plan's academy allowance and the rest of the quota footprint.
   *
   * The recompute enqueue is the one step that can throw (the queue is on
   * Redis); callers decide whether that may fail their request.
   */
  async afterArchiveCommitted(
    organizationId: string,
    presences: readonly ArchivedAcademyPresence[],
  ): Promise<void> {
    for (const presence of presences) {
      await this.invalidatePublicHostnames(
        presence.slug,
        presence.allocation,
        presence.previousHostname,
      );
      if (presence.releaseId) {
        await this.domainReleaseAfterCommit(presence.releaseId);
      }
    }
    await this.tenantUsageRecomputeProducer.enqueueOne(organizationId);
  }

  /**
   * Drops every cached hostname resolution that could answer for this
   * Academy (P63g): the allocation's label, its stored full host, the
   * effective full host, the slug forms and the connected custom hostname.
   * Also used by `AcademiesService` after branding writes, which change
   * what the resolution carries.
   */
  async invalidatePublicHostnames(
    slug: string,
    allocation: { readonly subdomain: string; readonly fullHost: string | null } | null,
    customHostname: string | null,
  ): Promise<void> {
    const platformDomain =
      await this.platformDomainConfigurationRepository.findSingleton();
    const { baseDomain } = resolveEffectiveBaseDomain(
      this.environmentBaseDomain,
      platformDomain,
    );
    const hosts = new Set<string>([slug]);
    if (allocation) {
      hosts.add(allocation.subdomain);
      if (allocation.fullHost) hosts.add(allocation.fullHost);
      const full = buildFullHost(allocation.subdomain, baseDomain);
      if (full) hosts.add(full);
    }
    const slugFull = buildFullHost(slug, baseDomain);
    if (slugFull) hosts.add(slugFull);
    if (platformDomain.baseDomain) hosts.add(`${slug}.${platformDomain.baseDomain}`);
    if (customHostname) hosts.add(customHostname);
    await this.publicWebsiteCacheService.invalidateHostnameResolution([...hosts]);
  }

  /** P63g — best-effort provider release after the archive committed; the sweep retries anything that fails. Never throws into the request. */
  private async domainReleaseAfterCommit(releaseId: string): Promise<void> {
    try {
      const platformOwner = await this.usersRepository.findFirstPlatformOwnerId();
      if (!platformOwner) return;
      const providerAvailable = await this.platformDomainService.isProviderAvailable();
      await this.tenancyContextService.runInUserContext(platformOwner.id, async (tx) => {
        const row = await this.domainProviderReleasesRepository.findById(tx, releaseId);
        if (row)
          await this.domainProviderReleaseService.attempt(tx, row, providerAvailable);
      });
    } catch {
      // Recorded in the ledger; the sweep retries.
    }
  }
}
