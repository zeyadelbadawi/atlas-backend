/**
 * Staff uploads for protected content and provider-hosted video —
 * `academies/:id/media/protected`, `academies/:id/media/video-uploads`
 * (master plan Phase 2 §L).
 *
 * Same guard stack as `MediaController`, verbatim: `JwtAuthGuard` +
 * `ManagementSurfaceGuard` + `AcademyScopeGuard`. These are staff
 * endpoints on the management surface, so a learner is refused at the
 * surface boundary before any of this code runs, and the academy in the
 * path is verified against the caller's real membership rather than
 * trusted.
 */
import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { ProtectedMediaService } from '../services/protected-media.service';
import type { VideoUploadTicket } from '../services/protected-media.service';
import { CreateVideoUploadDto, UploadProtectedFileDto } from '../dto/protected-media.dto';
import { toProtectedMediaAssetResponse } from '../dto/protected-media-asset.contract';
import type { ProtectedMediaAssetResponse } from '../dto/protected-media-asset.contract';

@Controller('academies')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, AcademyScopeGuard)
export class ProtectedMediaController {
  constructor(private readonly protectedMediaService: ProtectedMediaService) {}

  @Post(':id/media/protected')
  async uploadProtected(
    @Req() request: Request,
    @Body() body: UploadProtectedFileDto,
  ): Promise<ProtectedMediaAssetResponse> {
    const { academyId, organizationId } = request.academyContext!;
    const asset = await this.protectedMediaService.uploadProtectedFile(
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
    return toProtectedMediaAssetResponse(asset);
  }

  /**
   * Reserves quota and hands back a one-shot provider upload URL.
   *
   * The browser uploads STRAIGHT TO THE PROVIDER with that URL — no video
   * byte passes through this server (AD-1), which is what keeps a single
   * VPS off the media path.
   */
  /**
   * Finalises an upload for a provider with no webhook (finding D-4).
   *
   * The Normal tier's bytes land in Atlas's own bucket, and nothing tells
   * the server that happened — so the uploader says so, and the server
   * VERIFIES it rather than believing it: the object is HEADed and its
   * real duration is parsed from the container. Idempotent, because a
   * client that retried a timed-out call has done nothing wrong.
   */
  @Post(':id/media/video-uploads/:assetId/complete')
  async completeVideoUpload(
    @Req() request: Request,
    @Param('assetId') assetId: string,
  ): Promise<ProtectedMediaAssetResponse> {
    const { academyId, organizationId } = request.academyContext!;
    const asset = await this.protectedMediaService.completeVideoUpload(
      academyId,
      organizationId,
      request.authContext!.userId,
      assetId,
    );
    return toProtectedMediaAssetResponse(asset);
  }

  @Post(':id/media/video-uploads')
  async createVideoUpload(
    @Req() request: Request,
    @Body() body: CreateVideoUploadDto,
  ): Promise<VideoUploadTicket> {
    const { academyId, organizationId } = request.academyContext!;
    return this.protectedMediaService.createVideoUpload(
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }
}
