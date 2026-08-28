/**
 * PlatformSettingsService — `GET /platform-settings`/`PATCH
 * /platform-settings` (master plan §21 Phase P15). A singleton, no RLS
 * (see `PlatformSettingsRepository`'s own doc comment) — `PlatformOwnerGuard`
 * at the controller is the real, sole protection. `updateConfiguration`
 * is a genuine partial update: only the fields present in the DTO are
 * ever touched, matching `GeneralSettings`/`SecuritySettings` (atlas
 * frontend) each submitting only their own fields. The settings write and
 * its audit-log entry share one `$transaction` — this phase's own
 * atomicity rule.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { PlatformSettingsRepository } from '../repositories/platform-settings.repository';
import { toPlatformConfigurationResponse } from '../dto/platform-settings.contract';
import type { PlatformConfigurationResponse } from '../dto/platform-settings.contract';
import type { UpdatePlatformSettingsDto } from '../dto/update-platform-settings.dto';

@Injectable()
export class PlatformSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly platformSettingsRepository: PlatformSettingsRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

  async getConfiguration(): Promise<PlatformConfigurationResponse> {
    const settings = await this.platformSettingsRepository.findSingleton();
    return toPlatformConfigurationResponse(settings);
  }

  async updateConfiguration(
    platformOwnerId: string,
    payload: UpdatePlatformSettingsDto,
  ): Promise<PlatformConfigurationResponse> {
    const data: Partial<{
      platformName: string;
      platformDescription: string | null;
      supportEmail: string | null;
      twoFactorRequired: boolean;
      sessionTimeoutMinutes: number | null;
    }> = {};
    const auditContext: Record<string, string | number | boolean> = {};

    if (payload.platformName !== undefined) {
      data.platformName = payload.platformName;
      auditContext.platformName = payload.platformName;
    }
    if (payload.platformDescription !== undefined) {
      data.platformDescription = payload.platformDescription;
      auditContext.platformDescription = payload.platformDescription;
    }
    if (payload.supportEmail !== undefined) {
      data.supportEmail = payload.supportEmail;
      auditContext.supportEmail = payload.supportEmail;
    }
    if (payload.twoFactorRequired !== undefined) {
      data.twoFactorRequired = payload.twoFactorRequired;
      auditContext.twoFactorRequired = payload.twoFactorRequired;
    }
    if (payload.sessionTimeoutMinutes !== undefined) {
      data.sessionTimeoutMinutes =
        payload.sessionTimeoutMinutes === 'never' ? null : payload.sessionTimeoutMinutes;
      auditContext.sessionTimeoutMinutes = payload.sessionTimeoutMinutes;
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await this.platformSettingsRepository.update(tx, data);

      await this.auditLogWriterService.write(tx, {
        actorUserId: platformOwnerId,
        action: 'platform_settings.updated',
        targetType: 'platform_settings',
        targetId: updated.id,
        context: auditContext,
      });

      return toPlatformConfigurationResponse(updated);
    });
  }
}
