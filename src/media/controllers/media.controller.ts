/**
 * MediaController — `academies/:id/media*` (master plan §10, P8). Reuses
 * `AcademyScopeGuard` verbatim, unmodified — the same guard
 * `CoursesController` itself uses — since `:id` here is always the
 * ACADEMY id, exactly matching how `academies/:id/courses` etc. already
 * work.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ArchiveMediaBatchDto } from '../dto/archive-media-batch.dto';
import type { MediaBulkArchiveResponse } from '../services/media.service';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import {
  ACADEMY_STAFF_ROLES,
  AcademyRoles,
} from '../../academy/decorators/academy-roles.decorator';
import { MediaService } from '../services/media.service';
import { UploadMediaAssetDto } from '../dto/upload-media-asset.dto';
import { UpdateMediaAssetDto } from '../dto/update-media-asset.dto';
import { MediaListQueryDto } from '../dto/media-list-query.dto';
import type { MediaAssetResponse } from '../dto/media-asset.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('academies')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, AcademyScopeGuard)
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  /** W5 (F12) — an active staff role in THIS academy, or the organization owner. */
  @Get(':id/media')
  @AcademyRoles(...ACADEMY_STAFF_ROLES)
  async list(
    @Req() request: Request,
    @Query() query: MediaListQueryDto,
  ): Promise<PaginatedResult<MediaAssetResponse>> {
    const { academyId, organizationId } = request.academyContext!;
    return this.mediaService.list(academyId, organizationId, query);
  }

  @Get(':id/media/:assetId')
  @AcademyRoles(...ACADEMY_STAFF_ROLES)
  async getById(
    @Req() request: Request,
    @Param('assetId') assetId: string,
  ): Promise<MediaAssetResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.mediaService.getById(academyId, organizationId, assetId);
  }

  @Post(':id/media')
  async upload(
    @Req() request: Request,
    @Body() body: UploadMediaAssetDto,
  ): Promise<MediaAssetResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.mediaService.upload(
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }

  @Patch(':id/media/:assetId')
  async update(
    @Req() request: Request,
    @Param('assetId') assetId: string,
    @Body() body: UpdateMediaAssetDto,
  ): Promise<MediaAssetResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.mediaService.update(
      academyId,
      organizationId,
      request.authContext!.userId,
      assetId,
      body,
    );
  }

  /**
   * Bulk delete (archive). Same authorization and usage guard as the single
   * route; each asset is reported as archived or refused with its reason.
   */
  @Post(':id/media/archive-batch')
  @HttpCode(HttpStatus.OK)
  async archiveBatch(
    @Req() request: Request,
    @Body() body: ArchiveMediaBatchDto,
  ): Promise<MediaBulkArchiveResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.mediaService.archiveMany(
      academyId,
      organizationId,
      request.authContext!.userId,
      body.assetIds,
    );
  }

  @Post(':id/media/:assetId/archive')
  async archive(
    @Req() request: Request,
    @Param('assetId') assetId: string,
  ): Promise<MediaAssetResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.mediaService.archive(
      academyId,
      organizationId,
      request.authContext!.userId,
      assetId,
    );
  }
}
