/**
 * DomainService — the customer's (Academy owner/administrator/manager)
 * domain surface: `academies/:id/website/domain*` (P11; reworked P63).
 *
 * Every method independently re-establishes the RLS tenant context via
 * `TenancyContextService.runInTenantAndUserContext`. Write authorization
 * reuses P9/P10's exact `owner`/`administrator`/`manager` `assertCanManage`
 * pattern (`academy.website.manage` on the frontend).
 *
 * P63 guarantees, all enforced here or in the database, never in React:
 *   - IDEMPOTENT ADD: re-submitting the same hostname reuses the provider
 *     resource and keeps its verification records; changing hostname
 *     releases the previous provider resource first.
 *   - DUPLICATE OWNERSHIP: a hostname another Academy holds is refused
 *     (409) — inside the tenant's own RLS view for a friendly error, and
 *     by the real UNIQUE index for the cross-tenant case RLS hides.
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
  ConflictException,
  ForbiddenException,
  Inject,
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
import { SubdomainAllocationsRepository } from '../repositories/subdomain-allocations.repository';
import { DomainConnectionsRepository } from '../repositories/domain-connections.repository';
import { CLOUDFLARE_PROVIDER } from '../providers/cloudflare-provider.interface';
import type { CloudflareProvider } from '../providers/cloudflare-provider.interface';
import { DomainCheckService } from './domain-check.service';
import { PlatformDomainService } from './platform-domain.service';
import {
  toAcademyDomainConfigurationResponse,
  type AcademyDomainConfigurationResponse,
} from '../dto/domain.contract';
import type { AddCustomDomainDto } from '../dto/add-custom-domain.dto';
import { DOMAIN_AUDIT_ACTIONS } from '../constants/domain.constants';
import { resolveCanonicalHost, resolveSubdomainHost } from '../utils/canonical-host.util';

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

const MANAGING_ROLES = new Set(['owner', 'administrator', 'manager']);

@Injectable()
export class DomainService {
  private readonly logger = new Logger(DomainService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly subdomainAllocationsRepository: SubdomainAllocationsRepository,
    private readonly domainConnectionsRepository: DomainConnectionsRepository,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly domainCheckService: DomainCheckService,
    private readonly platformDomainService: PlatformDomainService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly publicWebsiteCacheService: PublicWebsiteCacheService,
    @Inject(CLOUDFLARE_PROVIDER)
    private readonly cloudflareProvider: CloudflareProvider,
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

  private async releaseFromProvider(existing: DomainConnection | null): Promise<void> {
    if (!existing?.hostname) return;
    const connected = await this.cloudflareProvider.verifyToken();
    if (!connected) return;
    try {
      const resource = existing.providerHostnameId
        ? await this.cloudflareProvider.getCustomHostnameById(existing.providerHostnameId)
        : await this.cloudflareProvider.getCustomHostnameByHostname(existing.hostname);
      if (resource) await this.cloudflareProvider.deleteCustomHostname(resource.id);
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : 'unknown' },
        'Provider custom hostname release failed',
      );
    }
  }

  async addCustomDomain(
    academyId: string,
    organizationId: string,
    userId: string,
    payload: AddCustomDomainDto,
  ): Promise<AcademyDomainConfigurationResponse> {
    const { response, subdomain, previousHostname } =
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
          // `upsert` below runs — handled explicitly, never a raw 500.
          const existingForHostname =
            await this.domainConnectionsRepository.findByHostname(tx, payload.hostname);
          if (existingForHostname && existingForHostname.academyId !== academyId) {
            throw new ConflictException({ messageKey: 'errors.domain.hostnameTaken' });
          }

          const sameHostname = existing?.hostname === payload.hostname;
          if (existing?.hostname && !sameHostname) {
            // Changing hostname: the old provider resource must not linger
            // (it would keep answering for a hostname the customer gave up).
            await this.releaseFromProvider(existing);
          }

          let domainConnection: DomainConnection;
          try {
            domainConnection = await this.domainConnectionsRepository.upsert(
              tx,
              academyId,
              {
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
                sslStatus: 'not_configured',
                cdnStatus: 'not_configured',
                cdnProvider: null,
                connectedAt: null,
                lastCheckedAt: null,
                lastCheckError: null,
                lastProviderErrorCode: null,
                httpsReachable: null,
                httpsCheckedAt: null,
                httpsStatusCode: null,
                httpsFailureReason: null,
              },
            );
          } catch (error) {
            if (isUniqueConstraintViolation(error)) {
              throw new ConflictException({ messageKey: 'errors.domain.hostnameTaken' });
            }
            throw error;
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
          };
        },
      );

    await this.invalidatePublicResolution(subdomain, previousHostname, payload.hostname);
    return response;
  }

  async removeCustomDomain(
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<AcademyDomainConfigurationResponse> {
    const { response, subdomain, previousHostname } =
      await this.tenancyContextService.runInTenantAndUserContext(
        organizationId,
        userId,
        async (tx) => {
          await this.assertCanManage(tx, academyId, userId);
          const existing = await this.domainConnectionsRepository.lockByAcademyId(
            tx,
            academyId,
          );

          await this.releaseFromProvider(existing);

          // Reset, never a hard delete — see this table's own RLS doc comment
          // (no DELETE policy exists on `domain_connections`).
          const domainConnection = await this.domainConnectionsRepository.upsert(
            tx,
            academyId,
            {
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
            },
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
          };
        },
      );

    await this.invalidatePublicResolution(subdomain, previousHostname);
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
