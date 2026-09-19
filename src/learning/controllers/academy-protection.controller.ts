/**
 * Owner-only academy settings — `academies/:id/content-protection` and
 * `academies/:id/device-policy` (master plan D8, Phase 2 §L).
 *
 * Same guard stack every academy-scoped management route uses. The
 * OWNER-ONLY half is enforced in the service by
 * `assertCanManageSecurityPolicy`, not here: `AcademyScopeGuard` proves
 * the caller belongs to this academy, and the role rule belongs next to
 * the write it governs, where the audit entry is written in the same
 * transaction.
 */
import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { AcademyProtectionService } from '../services/academy-protection.service';
import type {
  AcademyDevicePolicyResponse,
  AcademyVideoTierResponse,
} from '../services/academy-protection.service';
import {
  UpdateContentProtectionDto,
  UpdateDevicePolicyDto,
  UpdateVideoTierDto,
} from '../dto/academy-protection.dto';
import type { AcademyContentProtection } from '../dto/content-protection.contract';

@Controller('academies')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, AcademyScopeGuard)
export class AcademyProtectionController {
  constructor(private readonly academyProtectionService: AcademyProtectionService) {}

  @Get(':id/content-protection')
  async getContentProtection(@Req() request: Request): Promise<AcademyContentProtection> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academyProtectionService.getContentProtection(
      academyId,
      organizationId,
      request.authContext!.userId,
    );
  }

  @Patch(':id/content-protection')
  async updateContentProtection(
    @Req() request: Request,
    @Body() body: UpdateContentProtectionDto,
  ): Promise<AcademyContentProtection> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academyProtectionService.updateContentProtection(
      academyId,
      organizationId,
      request.authContext!.userId,
      body.contentProtection,
    );
  }

  /**
   * The academy's default video tier (D10) — owner only, like every other
   * security-sensitive setting (D8).
   *
   * The response carries what the plan ENTITLES as well as what the
   * academy chose, so the settings screen shows the real ceiling instead
   * of offering a choice the server would refuse.
   */
  @Get(':id/video-tier')
  async getVideoTier(@Req() request: Request): Promise<AcademyVideoTierResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academyProtectionService.getVideoTier(
      academyId,
      organizationId,
      request.authContext!.userId,
    );
  }

  /** Changes the tier for NEW uploads only — existing assets are never migrated (D11). */
  @Patch(':id/video-tier')
  async updateVideoTier(
    @Req() request: Request,
    @Body() body: UpdateVideoTierDto,
  ): Promise<AcademyVideoTierResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academyProtectionService.updateVideoTier(
      academyId,
      organizationId,
      request.authContext!.userId,
      body.videoSecurityTier,
    );
  }

  @Get(':id/device-policy')
  async getDevicePolicy(@Req() request: Request): Promise<AcademyDevicePolicyResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academyProtectionService.getDevicePolicy(
      academyId,
      organizationId,
      request.authContext!.userId,
    );
  }

  @Patch(':id/device-policy')
  async updateDevicePolicy(
    @Req() request: Request,
    @Body() body: UpdateDevicePolicyDto,
  ): Promise<AcademyDevicePolicyResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academyProtectionService.updateDevicePolicy(
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }
}
