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
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { MediaService } from '../services/media.service';
import { UploadMediaAssetDto } from '../dto/upload-media-asset.dto';
import { UpdateMediaAssetDto } from '../dto/update-media-asset.dto';
import { MediaListQueryDto } from '../dto/media-list-query.dto';
import type { MediaAssetResponse } from '../dto/media-asset.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('academies')
@UseGuards(JwtAuthGuard, AcademyScopeGuard)
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Get(':id/media')
  async list(
    @Req() request: Request,
    @Query() query: MediaListQueryDto,
  ): Promise<PaginatedResult<MediaAssetResponse>> {
    const { academyId, organizationId } = request.academyContext!;
    return this.mediaService.list(academyId, organizationId, query);
  }

  @Get(':id/media/:assetId')
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
