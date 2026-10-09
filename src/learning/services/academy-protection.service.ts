/**
 * Content-protection and device-policy settings, both OWNER ONLY
 * (master plan D8, Phase 2 §D.9, §G).
 *
 * Reuses `assertCanManageSecurityPolicy` — the same owner-only check P64
 * Phase 1 introduced for the registration policy — rather than inventing
 * a second definition of "this is a security setting". That matters
 * because the three settings are the same KIND of decision: who may join,
 * how protected the content is, and how many devices may use it. An
 * academy where a manager can change one but not the others would be
 * inconsistent in a way nobody could explain.
 *
 * THE DEVICE POLICY IS CLAMPED TO THE PLATFORM MAXIMUM AT WRITE TIME as
 * well as at read time. Storing a value above the ceiling and silently
 * resolving it downwards would show the owner a number their learners
 * never actually get; refusing the write tells them the truth.
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, VideoSecurityTier } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import { AccessPolicyService } from '../../tenancy/services/access-policy.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { assertCanManageSecurityPolicy } from './learning-access.util';
import { VideoTierService } from '../../plans/services/video-tier.service';
import {
  resolveContentProtection,
  type AcademyContentProtection,
} from '../dto/content-protection.contract';
import type {
  ContentProtectionDto,
  UpdateDevicePolicyDto,
} from '../dto/academy-protection.dto';

/** What the owner-facing tier screen needs: the choice, the ceiling, and which decided. */
export interface AcademyVideoTierResponse {
  readonly academyId: string;
  readonly videoSecurityTier: VideoSecurityTier;
  readonly entitled: VideoSecurityTier;
  readonly source: 'academy' | 'plan';
}

export interface AcademyDevicePolicyResponse {
  readonly academyId: string;
  readonly maxDevices: number;
  readonly maxConcurrentSessions: number;
  readonly source: 'academy' | 'plan' | 'platform' | 'default';
  /** What the platform allows at most, so the settings screen can show the real ceiling rather than guessing. */
  readonly platformMaxDevices: number;
  readonly platformMaxConcurrentSessions: number;
}

@Injectable()
export class AcademyProtectionService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly accessPolicyService: AccessPolicyService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly videoTierService: VideoTierService,
  ) {}

  async getContentProtection(
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<AcademyContentProtection> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await assertCanManageSecurityPolicy(
          tx,
          this.academyMembersRepository,
          academyId,
          userId,
        );
        const academy = await tx.academy.findUnique({
          where: { id: academyId },
          select: { contentProtection: true },
        });
        if (!academy) throw new NotFoundException({ messageKey: 'errors.notFound' });
        return resolveContentProtection(academy.contentProtection);
      },
    );
  }

  async updateContentProtection(
    academyId: string,
    organizationId: string,
    userId: string,
    payload: ContentProtectionDto,
  ): Promise<AcademyContentProtection> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await assertCanManageSecurityPolicy(
          tx,
          this.academyMembersRepository,
          academyId,
          userId,
        );
        // `watermark` / `watermarkText` in the payload are accepted for the
        // previously deployed frontend and ignored: the forensic watermark is
        // mandatory (docs/FORENSIC_WATERMARK.md).
        const next: AcademyContentProtection = {
          watermark: true,
          watermarkText: null,
          disableDownload: payload.disableDownload,
          disablePip: payload.disablePip,
          disableContextMenu: payload.disableContextMenu,
        };
        const academy = await tx.academy.update({
          where: { id: academyId },
          data: { contentProtection: next as unknown as Prisma.InputJsonObject },
          select: { contentProtection: true },
        });
        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          organizationId,
          academyId,
          role: 'owner',
          action: 'academy.content_protection.updated',
          targetType: 'academy',
          targetId: academyId,
          // Flat scalars only, per `AuditLogEntry.context`'s own contract.
          context: {
            watermark: next.watermark,
            disableDownload: next.disableDownload,
            disablePip: next.disablePip,
            disableContextMenu: next.disableContextMenu,
          },
        });
        return resolveContentProtection(academy.contentProtection);
      },
    );
  }

  /**
   * The academy's default upload tier, and what its plan allows.
   *
   * Returns BOTH so the settings screen can render the real ceiling
   * rather than guessing — the same shape the device policy already
   * uses, and the reason an owner is never shown a choice their plan
   * would refuse.
   */
  async getVideoTier(
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<AcademyVideoTierResponse> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await assertCanManageSecurityPolicy(
          tx,
          this.academyMembersRepository,
          academyId,
          userId,
        );
        const resolved = await this.videoTierService.resolve(tx, {
          academyId,
          organizationId,
        });
        return {
          academyId,
          videoSecurityTier: resolved.tier,
          entitled: resolved.entitled,
          source: resolved.source,
        };
      },
    );
  }

  async updateVideoTier(
    academyId: string,
    organizationId: string,
    userId: string,
    requested: VideoSecurityTier,
  ): Promise<AcademyVideoTierResponse> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await assertCanManageSecurityPolicy(
          tx,
          this.academyMembersRepository,
          academyId,
          userId,
        );
        // Refused, not silently lowered (D10). An owner shown "Premium"
        // whose learners get Normal has been told something untrue.
        await this.videoTierService.assertEntitled(tx, organizationId, requested);

        await tx.academy.update({
          where: { id: academyId },
          data: { videoSecurityTier: requested },
        });

        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          organizationId,
          academyId,
          role: 'owner',
          action: 'academy.video_tier.updated',
          targetType: 'academy',
          targetId: academyId,
          targetLabel: requested,
          // Stated in the audit entry because it is the question anyone
          // reading it will ask: this changed what NEW uploads get, and
          // nothing about the videos that already exist (D11).
          context: { appliesTo: 'new_uploads_only', requested },
        });

        const resolved = await this.videoTierService.resolve(tx, {
          academyId,
          organizationId,
        });
        return {
          academyId,
          videoSecurityTier: resolved.tier,
          entitled: resolved.entitled,
          source: resolved.source,
        };
      },
    );
  }

  async getDevicePolicy(
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<AcademyDevicePolicyResponse> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await assertCanManageSecurityPolicy(
          tx,
          this.academyMembersRepository,
          academyId,
          userId,
        );
        const [resolved, maximums] = await Promise.all([
          this.accessPolicyService.resolveForAcademy(tx, academyId),
          this.accessPolicyService.platformMaximums(tx),
        ]);
        return {
          academyId,
          maxDevices: resolved.maxDevices,
          maxConcurrentSessions: resolved.maxConcurrentSessions,
          source: resolved.source,
          platformMaxDevices: maximums.maxDevices,
          platformMaxConcurrentSessions: maximums.maxConcurrentSessions,
        };
      },
    );
  }

  async updateDevicePolicy(
    academyId: string,
    organizationId: string,
    userId: string,
    payload: UpdateDevicePolicyDto,
  ): Promise<AcademyDevicePolicyResponse> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await assertCanManageSecurityPolicy(
          tx,
          this.academyMembersRepository,
          academyId,
          userId,
        );
        const maximums = await this.accessPolicyService.platformMaximums(tx);
        if (
          payload.maxDevices > maximums.maxDevices ||
          payload.maxConcurrentSessions > maximums.maxConcurrentSessions
        ) {
          // Refused, not silently lowered: an owner who is shown 5 and
          // whose learners get 2 has been told something untrue.
          throw new BadRequestException({
            messageKey: 'errors.academy.devicePolicyAboveMaximum',
            details: {
              platformMaxDevices: maximums.maxDevices,
              platformMaxConcurrentSessions: maximums.maxConcurrentSessions,
            },
          });
        }

        await tx.accessPolicy.upsert({
          where: { academyId },
          create: {
            scope: 'academy',
            academyId,
            maxDevices: payload.maxDevices,
            maxConcurrentSessions: payload.maxConcurrentSessions,
          },
          update: {
            maxDevices: payload.maxDevices,
            maxConcurrentSessions: payload.maxConcurrentSessions,
          },
        });

        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          organizationId,
          academyId,
          role: 'owner',
          action: 'academy.device_policy.updated',
          targetType: 'academy',
          targetId: academyId,
          context: {
            maxDevices: payload.maxDevices,
            maxConcurrentSessions: payload.maxConcurrentSessions,
          },
        });

        const resolved = await this.accessPolicyService.resolveForAcademy(tx, academyId);
        return {
          academyId,
          maxDevices: resolved.maxDevices,
          maxConcurrentSessions: resolved.maxConcurrentSessions,
          source: resolved.source,
          platformMaxDevices: maximums.maxDevices,
          platformMaxConcurrentSessions: maximums.maxConcurrentSessions,
        };
      },
    );
  }
}
