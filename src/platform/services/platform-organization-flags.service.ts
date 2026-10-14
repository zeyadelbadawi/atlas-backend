/**
 * B0-ANL-04 — reads and sets the operator-only flags of one organization.
 *
 * Runs under the acting Platform Owner's context: the
 * `organization_platform_flags_platform_*` policies are the only access
 * there is (no tenant policy exists), and the organization itself is read
 * through `organizations_platform_select`. A non-Platform-Owner id reads
 * nothing and cannot write, even if the guard were missing.
 *
 * Every change is audited (`organization.internal_flag_changed`,
 * operator-only) in the same transaction as the write; setting the value
 * it already has writes nothing.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { OrganizationsRepository } from '../../tenancy/repositories/organizations.repository';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import type { OrganizationPlatformFlagsResponse } from '../dto/organization-platform-flags.dto';

@Injectable()
export class PlatformOrganizationFlagsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly organizationsRepository: OrganizationsRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

  async get(
    platformOwnerId: string,
    organizationId: string,
  ): Promise<OrganizationPlatformFlagsResponse> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const organization = await this.organizationsRepository.findByIdAnyOrganization(
        tx,
        organizationId,
      );
      if (!organization) throw new NotFoundException({ messageKey: 'errors.notFound' });
      const flags = await tx.organizationPlatformFlags.findUnique({
        where: { organizationId },
      });
      return {
        organizationId,
        isInternal: flags?.isInternal ?? false,
        ...(flags ? { updatedAt: flags.updatedAt.toISOString() } : {}),
      };
    });
  }

  async setInternal(
    platformOwnerId: string,
    organizationId: string,
    isInternal: boolean,
  ): Promise<OrganizationPlatformFlagsResponse> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const organization = await this.organizationsRepository.findByIdAnyOrganization(
        tx,
        organizationId,
      );
      if (!organization) throw new NotFoundException({ messageKey: 'errors.notFound' });
      const previous = await tx.organizationPlatformFlags.findUnique({
        where: { organizationId },
      });
      const wasInternal = previous?.isInternal ?? false;
      if (previous && wasInternal === isInternal) {
        return {
          organizationId,
          isInternal,
          updatedAt: previous.updatedAt.toISOString(),
        };
      }
      const flags = await tx.organizationPlatformFlags.upsert({
        where: { organizationId },
        create: { organizationId, isInternal, updatedByUserId: platformOwnerId },
        update: { isInternal, updatedByUserId: platformOwnerId },
      });
      if (wasInternal !== isInternal) {
        await this.auditLogWriterService.write(tx, {
          actorUserId: platformOwnerId,
          organizationId,
          role: 'platform_owner',
          action: 'organization.internal_flag_changed',
          targetType: 'organization',
          targetId: organizationId,
          targetLabel: organization.name,
          context: { isInternal, previousIsInternal: wasInternal },
        });
      }
      return {
        organizationId,
        isInternal: flags.isInternal,
        updatedAt: flags.updatedAt.toISOString(),
      };
    });
  }
}
