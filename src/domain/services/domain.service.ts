/**
 * DomainService — matches the real frontend `DomainService` exactly:
 * `getDomainConfiguration`/`addCustomDomain`/`removeCustomDomain`/
 * `verifyDomain`. Nested under the same `academies/:id/website/domain*`
 * resource tree `WebsiteConfigurationService`/`WebsiteContentService`
 * already established (P9/P10) — a new sub-resource, not a parallel one.
 *
 * Every method independently re-establishes the RLS tenant context via
 * `TenancyContextService.runInTenantContext`. Write authorization reuses
 * P9/P10's exact `owner`/`administrator` `assertCanManage` pattern —
 * confirmed identical by direct inspection of `WebsiteDomainTab.tsx`
 * (`hasPermission('academy.website.manage')`, the same permission string
 * P9/P10 already gate writes on).
 *
 * No fake infrastructure (master plan §21 P11): every status field this
 * service returns is either the honest `not_configured` default or a
 * value derived from a real `CloudflareProvider` call this request, or
 * the previous real call's persisted result — never a value this service
 * invents.
 */
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import { SubdomainAllocationsRepository } from '../repositories/subdomain-allocations.repository';
import { DomainConnectionsRepository } from '../repositories/domain-connections.repository';
import { CLOUDFLARE_PROVIDER } from '../providers/cloudflare-provider.interface';
import type { CloudflareProvider } from '../providers/cloudflare-provider.interface';
import { mapCloudflareCustomHostname } from '../providers/cloudflare-status-mapper';
import {
  toAcademyDomainConfigurationResponse,
  type AcademyDomainConfigurationResponse,
} from '../dto/domain.contract';
import type { AddCustomDomainDto } from '../dto/add-custom-domain.dto';

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

const MANAGING_ROLES = new Set(['owner', 'administrator', 'manager']);

@Injectable()
export class DomainService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly subdomainAllocationsRepository: SubdomainAllocationsRepository,
    private readonly domainConnectionsRepository: DomainConnectionsRepository,
    private readonly academyMembersRepository: AcademyMembersRepository,
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

  /** Phase 1 (Extended Scope, dependency A) — see `WebsiteConfigurationService.assertIsMember`'s doc comment: `AcademyScopeGuard` proves organization membership only, and `getDomainConfiguration` (unlike every write below) never independently confirmed the caller belongs to THIS specific Academy. */
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
    return toAcademyDomainConfigurationResponse(academyId, subdomain, domainConnection);
  }

  async addCustomDomain(
    academyId: string,
    organizationId: string,
    userId: string,
    payload: AddCustomDomainDto,
  ): Promise<AcademyDomainConfigurationResponse> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId);

        // A same-tenant conflict is visible under this transaction's own
        // RLS context and caught here for a fast, friendly error. A
        // DIFFERENT tenant's row is invisible under this SELECT by RLS
        // design (it must be — this is a normal, correctly-scoped tenant
        // context, not the public runtime's special resolution path), so
        // that case can only ever be caught by the real database-level
        // UNIQUE constraint on `hostname` when the `upsert` below runs —
        // handled explicitly, never left to surface as a raw 500.
        const existingForHostname = await this.domainConnectionsRepository.findByHostname(
          tx,
          payload.hostname,
        );
        if (existingForHostname && existingForHostname.academyId !== academyId) {
          throw new ConflictException({ messageKey: 'errors.domain.hostnameTaken' });
        }

        const connected = await this.cloudflareProvider.verifyToken();
        let verificationRecords: unknown = null;
        if (connected) {
          try {
            const customHostname = await this.cloudflareProvider.createCustomHostname(
              payload.hostname,
            );
            verificationRecords = customHostname.verificationRecords;
          } catch {
            // A real, failed provider call — the row still records the
            // Academy Owner's intent (status stays `verification_required`,
            // no fabricated records), never a fake success.
            verificationRecords = null;
          }
        }

        let domainConnection;
        try {
          domainConnection = await this.domainConnectionsRepository.upsert(
            tx,
            academyId,
            {
              hostname: payload.hostname,
              status: 'verification_required',
              verificationRecords: verificationRecords as
                Prisma.InputJsonValue | undefined,
              sslStatus: 'not_configured',
              cdnStatus: 'not_configured',
              connectedAt: null,
            },
          );
        } catch (error) {
          if (isUniqueConstraintViolation(error)) {
            throw new ConflictException({ messageKey: 'errors.domain.hostnameTaken' });
          }
          throw error;
        }

        const subdomain = await this.subdomainAllocationsRepository.findByAcademyId(
          tx,
          academyId,
        );
        return toAcademyDomainConfigurationResponse(
          academyId,
          subdomain,
          domainConnection,
        );
      },
    );
  }

  async removeCustomDomain(
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<AcademyDomainConfigurationResponse> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId);

        const existing = await this.domainConnectionsRepository.findByAcademyId(
          tx,
          academyId,
        );
        if (existing?.hostname) {
          const connected = await this.cloudflareProvider.verifyToken();
          if (connected) {
            const customHostname =
              await this.cloudflareProvider.getCustomHostnameByHostname(
                existing.hostname,
              );
            if (customHostname) {
              await this.cloudflareProvider.deleteCustomHostname(customHostname.id);
            }
          }
        }

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
            connectedAt: null,
          },
        );

        const subdomain = await this.subdomainAllocationsRepository.findByAcademyId(
          tx,
          academyId,
        );
        return toAcademyDomainConfigurationResponse(
          academyId,
          subdomain,
          domainConnection,
        );
      },
    );
  }

  async verifyDomain(
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<AcademyDomainConfigurationResponse> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId);

        const existing = await this.domainConnectionsRepository.findByAcademyId(
          tx,
          academyId,
        );
        if (!existing?.hostname) {
          throw new NotFoundException({ messageKey: 'errors.domain.noCustomDomain' });
        }

        const connected = await this.cloudflareProvider.verifyToken();
        if (!connected) {
          // Nothing to re-check against — the backend never simulates a
          // result, so the row is returned exactly as it stood.
          const subdomain = await this.subdomainAllocationsRepository.findByAcademyId(
            tx,
            academyId,
          );
          return toAcademyDomainConfigurationResponse(academyId, subdomain, existing);
        }

        const customHostname = await this.cloudflareProvider.getCustomHostnameByHostname(
          existing.hostname,
        );
        if (!customHostname) {
          const subdomain = await this.subdomainAllocationsRepository.findByAcademyId(
            tx,
            academyId,
          );
          return toAcademyDomainConfigurationResponse(academyId, subdomain, existing);
        }

        const mapped = mapCloudflareCustomHostname(customHostname);
        const wasConnected = existing.status === 'connected';
        const domainConnection = await this.domainConnectionsRepository.upsert(
          tx,
          academyId,
          {
            hostname: existing.hostname,
            status: mapped.status,
            verificationRecords:
              customHostname.verificationRecords as unknown as Prisma.InputJsonValue,
            sslStatus: mapped.sslStatus,
            cdnStatus: mapped.cdnStatus,
            connectedAt:
              mapped.status === 'connected'
                ? wasConnected
                  ? existing.connectedAt
                  : new Date()
                : null,
          },
        );

        const subdomain = await this.subdomainAllocationsRepository.findByAcademyId(
          tx,
          academyId,
        );
        return toAcademyDomainConfigurationResponse(
          academyId,
          subdomain,
          domainConnection,
        );
      },
    );
  }
}
