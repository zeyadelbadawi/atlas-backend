/**
 * OrganizationAcquisitionService — G1: the Platform Owner's manual channel
 * for an organization (`organization_platform_flags.acquisition_channel_override`),
 * for founder-led signups (WhatsApp, calls) whose source is known. It wins
 * over every other signal in the resolver.
 *
 * Runs in the Platform Owner's context: the table's existing
 * `organization_platform_flags_platform_*` policies are the only access
 * (no tenant policy). A change is audited (`platform.growth.organization_channel_set`)
 * in the same transaction; setting the same channel and note writes nothing.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import type { PlatformDomainRuntimeConfig } from '../../config/configuration';
import type { SetOrganizationChannelDto } from '../dto/growth.dto';
import type { OrganizationAcquisitionResponse } from '../dto/growth.contract';
import { GROWTH_AUDIT, GROWTH_ERRORS, GROWTH_ROLE } from '../growth.constants';
import { readOrganizationAcquisition } from '../organization-acquisition.reader';

@Injectable()
export class OrganizationAcquisitionService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly configService: ConfigService,
  ) {}

  platformBaseDomain(): string | undefined {
    return this.configService.get<PlatformDomainRuntimeConfig>('platformDomain')
      ?.baseDomain;
  }

  async setChannel(
    platformOwnerId: string,
    organizationId: string,
    payload: SetOrganizationChannelDto,
  ): Promise<OrganizationAcquisitionResponse> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const organization = await tx.organization.findUnique({
        where: { id: organizationId },
        select: { id: true, name: true },
      });
      if (!organization) {
        throw new NotFoundException({ messageKey: GROWTH_ERRORS.organizationNotFound });
      }
      const channel = payload.channel ?? null;
      const note = channel && payload.note ? payload.note : null;
      const previous = await tx.organizationPlatformFlags.findUnique({
        where: { organizationId },
      });
      const previousChannel = previous?.acquisitionChannelOverride ?? null;
      const previousNote = previous?.acquisitionOverrideNote ?? null;
      if (previousChannel !== channel || previousNote !== note) {
        await tx.organizationPlatformFlags.upsert({
          where: { organizationId },
          create: {
            organizationId,
            acquisitionChannelOverride: channel,
            acquisitionOverrideNote: note,
            updatedByUserId: platformOwnerId,
          },
          update: {
            acquisitionChannelOverride: channel,
            acquisitionOverrideNote: note,
            updatedByUserId: platformOwnerId,
          },
        });
        await this.auditLogWriterService.write(tx, {
          actorUserId: platformOwnerId,
          organizationId,
          role: GROWTH_ROLE,
          action: GROWTH_AUDIT.organizationChannelSet,
          targetType: 'organization',
          targetId: organizationId,
          targetLabel: organization.name,
          context: { channel, previousChannel },
        });
      }
      const acquisition = await readOrganizationAcquisition(
        tx,
        organizationId,
        this.platformBaseDomain(),
      );
      if (!acquisition) {
        throw new NotFoundException({ messageKey: GROWTH_ERRORS.organizationNotFound });
      }
      return acquisition;
    });
  }
}
