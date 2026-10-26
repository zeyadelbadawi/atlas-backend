/**
 * PlatformSiteAnnouncementsController — B3: `platform-site-announcements`,
 * the Platform Owner's banners and pop-ups. Guards exactly like
 * `PlatformFoundingAcademiesController`; RLS is the second line.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { SiteAnnouncementsService } from '../services/site-announcements.service';
import {
  CreateSiteAnnouncementDto,
  ListSiteAnnouncementsQueryDto,
  SiteAnnouncementVersionDto,
  UpdateSiteAnnouncementDto,
} from '../dto/site-announcements.dto';
import type { SiteAnnouncementResponse } from '../dto/site-announcements.contract';

function actor(request: Request): string {
  return request.authContext!.userId;
}

@Controller('platform-site-announcements')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, PlatformOwnerGuard)
export class PlatformSiteAnnouncementsController {
  constructor(private readonly service: SiteAnnouncementsService) {}

  @Get()
  list(
    @Req() request: Request,
    @Query() query: ListSiteAnnouncementsQueryDto,
  ): Promise<PaginatedResult<SiteAnnouncementResponse>> {
    return this.service.list(actor(request), query);
  }

  @Get(':id')
  get(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SiteAnnouncementResponse> {
    return this.service.get(actor(request), id);
  }

  @Post()
  create(
    @Req() request: Request,
    @Body() body: CreateSiteAnnouncementDto,
  ): Promise<SiteAnnouncementResponse> {
    return this.service.create(actor(request), body);
  }

  @Patch(':id')
  update(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateSiteAnnouncementDto,
  ): Promise<SiteAnnouncementResponse> {
    return this.service.update(actor(request), id, body);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SiteAnnouncementVersionDto,
  ): Promise<SiteAnnouncementResponse> {
    return this.service.activate(actor(request), id, body.version);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SiteAnnouncementVersionDto,
  ): Promise<SiteAnnouncementResponse> {
    return this.service.deactivate(actor(request), id, body.version);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  archive(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SiteAnnouncementVersionDto,
  ): Promise<SiteAnnouncementResponse> {
    return this.service.archive(actor(request), id, body.version);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.service.remove(actor(request), id);
  }
}
