/**
 * DomainService — the customer's (Academy owner/administrator/manager)
 * domain surface: `academies/:id/website/domain*` (P11; reworked P63,
 * hardened P63g).
 *
 * Every method independently re-establishes the RLS tenant context via
 * `TenancyContextService.runInTenantAndUserContext`. Write authorization
 * reuses P9/P10's exact `owner`/`administrator`/`manager` `assertCanManage`
 * pattern (`academy.website.manage` on the frontend).
 *
 * Guarantees, all enforced here or in the database, never in React:
 *   - IDEMPOTENT ADD: re-submitting the same hostname reuses the provider
 *     resource and keeps its verification records; changing hostname
 *     releases the previous provider resource AFTER the change commits.
 *   - NEVER THE PLATFORM'S OWN NAMES (P63g): the platform base domain, any
 *     name under it (every Academy's Atlas subdomain lives there) and the
 *     routing target are refused before the provider is asked. Public
 *     resolution prefers a connected custom hostname over a subdomain, so
 *     without this rule one tenant could claim another's Atlas address.
 *   - DUPLICATE OWNERSHIP: a hostname another Academy holds is refused
 *     (409) — inside the tenant's own RLS view for a friendly error, and
 *     by the real UNIQUE index for the cross-tenant case RLS hides.
 *   - NO DESTRUCTIVE PARTIAL OPERATION (P63g): the provider resource a
 *     replace/remove gives up is recorded in `domain_provider_releases`
 *     inside the same transaction, deleted at the provider only after
 *     commit, and retried by the sweep until the provider confirms. A
 *     refused replace (409) therefore leaves the working domain untouched.
 *   - CONCURRENCY: add/check/remove take the row lock
 *     (`lockByAcademyId`) so overlapping calls serialize per Academy.
 *   - SERVER-AUTHORITATIVE VERIFICATION: only `DomainCheckService`,
 *     recording what the provider returned, can move a row to
 *     `connected`. No request body can.
 *   - TRUTH: when the provider is unavailable the row is returned as it
 *     stood, with `lastCheckError` saying why — never a simulated result.
 *   - AUDIT: every mutation writes an audit row in the same transaction.
 *   - CACHE: the public runtime's hostname cache is invalidated whenever
 *     the canonical host could have changed.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { DomainConnection, SubdomainAllocation } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { PublicWebsiteCacheService } from '../../public-website/services/public-website-cache.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { SubdomainAllocationsRepository } from '../repositories/subdomain-allocations.repository';
import { DomainConnectionsRepository } from '../repositories/domain-connections.repository';
import { DomainProviderReleasesRepository } from '../repositories/domain-provider-releases.repository';
import { DomainCheckService } from './domain-check.service';
import { DomainProviderReleaseService } from './domain-provider-release.service';
import { PlatformDomainService } from './platform-domain.service';
import {
  toAcademyDomainConfigurationResponse,
  type AcademyDomainConfigurationResponse,
} from '../dto/domain.contract';
import type { AddCustomDomainDto } from '../dto/add-custom-domain.dto';
import {
  DOMAIN_AUDIT_ACTIONS,
  type DomainHostnameRefusal,
  type DomainReleaseReason,
} from '../constants/domain.constants';
import { resolveCanonicalHost, resolveSubdomainHost } from '../utils/canonical-host.util';

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

const MANAGING_ROLES = new Set(['owner', 'administrator', 'manager']);

/** The column reset that "no custom domain" means — one definition so remove, archive and operator release cannot drift. */
export const DOMAIN_CONNECTION_RESET: Omit<
  Prisma.DomainConnectionUncheckedCreateInput,
  'academyId'
> = {
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
};

/**
 * P63g — why a hostname must never be a custom domain: the platform's own
 * domain or anything under it, or the routing target itself.
 */
export function refuseHostnameReason(
  hostname: string,
  baseDomain: string | undefined,
  cnameTarget: string | null | undefined,
): DomainHostnameRefusal | null {
  const host = hostname.toLowerCase();
  if (baseDomain) {
    const base = baseDomain.toLowerCase();
    if (host === base || host.endsWith(`.${base}`)) return 'platform_domain';
  }
  if (cnameTarget && host === cnameTarget.toLowerCase()) return 'routing_target';
  return null;
}

@Injectable()
export class DomainService {
  private readonly logger = new Logger(DomainService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly subdomainAllocationsRepository: SubdomainAllocationsRepository,
    private readonly domainConnectionsRepository: DomainConnectionsRepository,
    private readonly releasesRepository: DomainProviderReleasesRepository,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly usersRepository: UsersRepository,
    private readonly domainCheckService: DomainCheckService,
    private readonly releaseService: DomainProviderReleaseService,
    private readonly platformDomainService: PlatformDomainService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly publicWebsiteCacheService: PublicWebsiteCacheService,
  ) {}

  private async assertCanManage(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<void> {
    const membership = await this.academyMembersRepository.findForUserInAcademy(
      tx,
      academyId,
      userId,
    );
    if (!membership || !MANAGING_ROLES.has(membership.role)) {
      throw new ForbiddenException({ messageKey: 'errors.domain.insufficientRole' });
    }
  }

  /** Phase 1 (Extended Scope, dependency A) — `AcademyScopeGuard` proves organization membership only; reads must still confirm the caller belongs to THIS Academy. */
  private async assertIsMember(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<void> {
    const membership = await this.academyMembersRepository.findForUserInAcademy(
      tx,
      academyId,
      userId,
    );
    if (!membership) {
      throw new ForbiddenException({ messageKey: 'errors.domain.insufficientRole' });
    }
  }

  /** Builds the response from the rows plus the two platform facts it needs (base domain, CNAME target). */
  private async toResponse(
    academyId: string,
    subdomain: SubdomainAllocation | null,
    domainConnection: DomainConnection | null,
  ): Promise<AcademyDomainConfigurationResponse> {
    const [{ baseDomain }, cnameTarget] = await Promise.all([
      this.platformDomainService.getEffectiveBaseDomain(),
      domainConnection?.hostname
        ? this.platformDomainService.getCnameTarget()
        : Promise.resolve(null),
    ]);
    const canonicalHost = resolveCanonicalHost({
      connectedCustomHostname:
        domainConnection?.status === 'connected' ? domainConnection.hostname : null,
      customHttpsReachable: domainConnection?.httpsReachable,
      subdomainFullHost: subdomain?.fullHost,
      subdomainLabel: subdomain?.subdomain,
      baseDomain,
    });
    return toAcademyDomainConfigurationResponse({
      academyId,
      subdomain,
      domainConnection,
      canonicalHost,
      cnameTarget,
    });
  }

  /** Every host whose public resolution could now answer differently. */
  private async invalidatePublicResolution(
    subdomain: SubdomainAllocation | null,
    ...hostnames: readonly (string | null | undefined)[]
  ): Promise<void> {
    const { baseDomain } = await this.platformDomainService.getEffectiveBaseDomain();
    const hosts = new Set<string>();
    for (const host of hostnames) if (host) hosts.add(host.toLowerCase());
    if (subdomain) {
      hosts.add(subdomain.subdomain.toLowerCase());
      const full = resolveSubdomainHost({
        subdomainFullHost: subdomain.fullHost,
        subdomainLabel: subdomain.subdomain,
        baseDomain,
      });
      if (full) hosts.add(full);
    }
    if (hosts.size)
      await this.publicWebsiteCacheService.invalidateHostnameResolution([...hosts]);
  }

  /**
   * P63g — after the transaction that gave a provider resource up has
   * COMMITTED, try the delete once under the platform context. Failure is
   * fine: the ledger row stays pending and the sweep retries it. Nothing
   * here can throw into the customer's request.
   */
  private async attemptReleasesAfterCommit(releaseIds: readonly string[]): Promise<void> {
    if (releaseIds.length === 0) return;
    try {
      const platformOwner = await this.usersRepository.findFirstPlatformOwnerId();
      if (!platformOwner) return;
      const providerAvailable = await this.platformDomainService.isProviderAvailable();
      await this.tenancyContextService.runInUserContext(platformOwner.id, async (tx) => {
        for (const id of releaseIds) {
          const row = await this.releasesRepository.findById(tx, id);
          if (row) await this.releaseService.attempt(tx, row, providerAvailable);
        }
      });
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : 'unknown' },
        'Post-commit provider release attempt failed; the sweep will retry',
      );
    }
  }

  async getDomainConfiguration(
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<AcademyDomainConfigurationResponse> {
    const [subdomain, domainConnection] =
      await this.tenancyContextService.runInTenantAndUserContext(
        organizationId,
        userId,
        async (tx) => {
          await this.assertIsMember(tx, academyId, userId);
          return [
            await this.subdomainAllocationsRepository.findByAcademyId(tx, academyId),
            await this.domainConnectionsRepository.findByAcademyId(tx, academyId),
          ] as const;
        },
      );
    return this.toResponse(academyId, subdomain, domainConnection);
  }

  /** P63g — refuses the platform's own names before any row or provider call. */
  private async assertHostnameAllowed(hostname: string): Promise<void> {
    const [{ baseDomain }, cnameTarget] = await Promise.all([
      this.platformDomainService.getEffectiveBaseDomain(),
      this.platformDomainService.getCnameTarget(),
    ]);
    const refusal = refuseHostnameReason(hostname, baseDomain, cnameTarget);
    if (refusal) {
      throw new BadRequestException({
        messageKey: 'errors.domain.hostnameReserved',
        refusal,
      });
    }
  }

  async addCustomDomain(
    academyId: string,
    organizationId: string,
    userId: string,
    payload: AddCustomDomainDto,
  ): Promise<AcademyDomainConfigurationResponse> {
    await this.assertHostnameAllowed(payload.hostname);

    const { response, subdomain, previousHostname, releaseIds } =
      await this.tenancyContextService.runInTenantAndUserContext(
        organizationId,
        userId,
        async (tx) => {
          await this.assertCanManage(tx, academyId, userId);
          const existing = await this.domainConnectionsRepository.lockByAcademyId(
            tx,
            academyId,
          );

          // A same-tenant conflict is visible under this transaction's own
          // RLS context and caught here for a fast, friendly error. A
          // DIFFERENT tenant's row is invisible under this SELECT by RLS
          // design, so that case can only ever be caught by the real
          // database-level UNIQUE constraint on `hostname` when the
          // `upsert` below runs — handled explicitly, never a raw 500, and
          // (P63g) BEFORE anything is released at the provider.
          const existingForHostname =
            await this.domainConnectionsRepository.findByHostname(tx, payload.hostname);
          if (existingForHostname && existingForHostname.academyId !== academyId) {
            throw new ConflictException({ messageKey: 'errors.domain.hostnameTaken' });
          }

          const sameHostname = existing?.hostname === payload.hostname;

          let domainConnection: DomainConnection;
          try {
            domainConnection = await this.domainConnectionsRepository.upsert(
              tx,
              academyId,
              {
                ...DOMAIN_CONNECTION_RESET,
                hostname: payload.hostname,
                // A same-hostname resubmission keeps the provider id and
                // whatever verification progress the provider already
                // reports; a new hostname starts from scratch. Registration
                // itself happens in the check below — the single path.
                status: 'verification_required',
                verificationRecords:
                  sameHostname && existing?.verificationRecords
                    ? (existing.verificationRecords as Prisma.InputJsonValue)
                    : Prisma.JsonNull,
                providerHostnameId: sameHostname
                  ? (existing?.providerHostnameId ?? null)
                  : null,
              },
            );
          } catch (error) {
            if (isUniqueConstraintViolation(error)) {
              throw new ConflictException({ messageKey: 'errors.domain.hostnameTaken' });
            }
            throw error;
          }

          // Changing hostname: the old provider resource must not linger
          // (it would keep answering for a hostname the customer gave up).
          // Recorded here, in the same transaction; deleted after commit.
          const releases: string[] = [];
          if (existing?.hostname && !sameHostname) {
            const release = await this.releasesRepository.enqueue(tx, {
              academyId,
              hostname: existing.hostname,
              providerHostnameId: existing.providerHostnameId,
              reason: 'replaced',
            });
            releases.push(release.id);
          }

          // Register with the provider and record what it says — the same
          // check every later retry runs, so add and "Check now" cannot
          // disagree, and a refusal is recorded with its reason instead of
          // being mistaken for a vanished hostname later.
          const outcome = await this.domainCheckService.check(tx, domainConnection);
          domainConnection = outcome.after;

          await this.auditLogWriterService.write(tx, {
            actorUserId: userId,
            organizationId,
            academyId,
            action: DOMAIN_AUDIT_ACTIONS.customDomainAdded,
            targetType: 'domain_connection',
            targetId: domainConnection.id,
            targetLabel: payload.hostname,
            context: {
              providerRegistered: Boolean(domainConnection.providerHostnameId),
              error: outcome.error,
              replacedHostname:
                existing?.hostname && !sameHostname ? existing.hostname : null,
            },
            changes: {
              hostname: { from: existing?.hostname ?? null, to: payload.hostname },
              status: {
                from: existing?.status ?? 'not_configured',
                to: domainConnection.status,
              },
            },
          });

          const subdomainRow = await this.subdomainAllocationsRepository.findByAcademyId(
            tx,
            academyId,
          );
          return {
            response: await this.toResponse(academyId, subdomainRow, domainConnection),
            subdomain: subdomainRow,
            previousHostname: existing?.hostname ?? null,
            releaseIds: releases,
          };
        },
      );

    await this.invalidatePublicResolution(subdomain, previousHostname, payload.hostname);
    await this.attemptReleasesAfterCommit(releaseIds);
    return response;
  }

  /**
   * Resets the row and records the release — shared by the customer's
   * Disconnect, the archive path and the operator release. Runs inside
   * the caller's transaction; returns the release id (if any) for the
   * post-commit attempt.
   */
  async resetInTransaction(
    tx: Prisma.TransactionClient,
    academyId: string,
    existing: DomainConnection | null,
    reason: DomainReleaseReason,
  ): Promise<{ readonly row: DomainConnection; readonly releaseId: string | null }> {
    let releaseId: string | null = null;
    if (existing?.hostname) {
      const release = await this.releasesRepository.enqueue(tx, {
        academyId,
        hostname: existing.hostname,
        providerHostnameId: existing.providerHostnameId,
        reason,
      });
      releaseId = release.id;
    }
    // Reset, never a hard delete — see this table's own RLS doc comment
    // (no DELETE policy exists on `domain_connections`).
    const row = existing
      ? await this.domainConnectionsRepository.updateByAcademyId(
          tx,
          academyId,
          DOMAIN_CONNECTION_RESET,
        )
      : await this.domainConnectionsRepository.upsert(
          tx,
          academyId,
          DOMAIN_CONNECTION_RESET,
        );
    return { row, releaseId };
  }

  async removeCustomDomain(
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<AcademyDomainConfigurationResponse> {
    const { response, subdomain, previousHostname, releaseId } =
      await this.tenancyContextService.runInTenantAndUserContext(
        organizationId,
        userId,
        async (tx) => {
          await this.assertCanManage(tx, academyId, userId);
          const existing = await this.domainConnectionsRepository.lockByAcademyId(
            tx,
            academyId,
          );

          const { row: domainConnection, releaseId } = await this.resetInTransaction(
            tx,
            academyId,
            existing,
            'removed',
          );

          if (existing?.hostname) {
            await this.auditLogWriterService.write(tx, {
              actorUserId: userId,
              organizationId,
              academyId,
              action: DOMAIN_AUDIT_ACTIONS.customDomainRemoved,
              targetType: 'domain_connection',
              targetId: domainConnection.id,
              targetLabel: existing.hostname,
              changes: {
                hostname: { from: existing.hostname, to: null },
                status: { from: existing.status, to: 'not_configured' },
              },
            });
          }

          const subdomainRow = await this.subdomainAllocationsRepository.findByAcademyId(
            tx,
            academyId,
          );
          return {
            response: await this.toResponse(academyId, subdomainRow, domainConnection),
            subdomain: subdomainRow,
            previousHostname: existing?.hostname ?? null,
            releaseId,
          };
        },
      );

    await this.invalidatePublicResolution(subdomain, previousHostname);
    await this.attemptReleasesAfterCommit(releaseId ? [releaseId] : []);
    return response;
  }

  async verifyDomain(
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<AcademyDomainConfigurationResponse> {
    const { response, subdomain, hostname, statusChanged } =
      await this.tenancyContextService.runInTenantAndUserContext(
        organizationId,
        userId,
        async (tx) => {
          await this.assertCanManage(tx, academyId, userId);
          const existing = await this.domainConnectionsRepository.lockByAcademyId(
            tx,
            academyId,
          );
          if (!existing?.hostname) {
            throw new NotFoundException({ messageKey: 'errors.domain.noCustomDomain' });
          }

          const outcome = await this.domainCheckService.check(tx, existing);

          await this.auditLogWriterService.write(tx, {
            actorUserId: userId,
            organizationId,
            academyId,
            action: DOMAIN_AUDIT_ACTIONS.verificationChecked,
            targetType: 'domain_connection',
            targetId: outcome.after.id,
            targetLabel: existing.hostname,
            context: {
              outcome: outcome.error ? 'failed' : 'succeeded',
              error: outcome.error,
              httpsReachable: outcome.after.httpsReachable ?? null,
              reRegistered: outcome.reRegistered,
            },
            changes: {
              status: { from: outcome.before.status, to: outcome.after.status },
              sslStatus: { from: outcome.before.sslStatus, to: outcome.after.sslStatus },
            },
          });

          const subdomainRow = await this.subdomainAllocationsRepository.findByAcademyId(
            tx,
            academyId,
          );
          return {
            response: await this.toResponse(academyId, subdomainRow, outcome.after),
            subdomain: subdomainRow,
            hostname: existing.hostname,
            statusChanged: outcome.canonicalMayHaveChanged,
          };
        },
      );

    if (statusChanged) await this.invalidatePublicResolution(subdomain, hostname);
    return response;
  }
}
