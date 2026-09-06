/**
 * AnnouncementsController — `announcements/*` (the visible feed) plus
 * `courses/:id/announcements/*` (course-scoped authoring), matching
 * `AnnouncementService`'s (frontend) two route trees exactly.
 * `JwtAuthGuard` alone — no academy-scoping guard, same reasoning as every
 * other P7 Community controller (see `InstructorController`'s doc
 * comment): the real scoping/authorization happens inside
 * `AnnouncementsService` and the RLS policies it runs under.
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
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { AnnouncementsService } from '../services/announcements.service';
import { CreateAnnouncementDto } from '../dto/create-announcement.dto';
import { UpdateAnnouncementDto } from '../dto/update-announcement.dto';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type { AnnouncementResponse } from '../dto/announcement.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@UseGuards(JwtAuthGuard)
@Controller()
export class AnnouncementsController {
  constructor(private readonly announcementsService: AnnouncementsService) {}

  @Get('announcements')
  async getFeed(
    @Req() request: Request,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<AnnouncementResponse>> {
    return this.announcementsService.getFeed(request.authContext!.userId, query);
  }

  @Get('announcements/:id')
  async getAnnouncement(
    @Req() request: Request,
    @Param('id') id: string,
  ): Promise<AnnouncementResponse> {
    return this.announcementsService.getAnnouncement(request.authContext!.userId, id);
  }

  @Get('courses/:courseId/announcements')
  async getCourseAnnouncements(
    @Req() request: Request,
    @Param('courseId') courseId: string,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<AnnouncementResponse>> {
    return this.announcementsService.getCourseAnnouncements(
      request.authContext!.userId,
      courseId,
      query,
    );
  }

  @Post('courses/:courseId/announcements')
  async createAnnouncement(
    @Req() request: Request,
    @Param('courseId') courseId: string,
    @Body() body: CreateAnnouncementDto,
  ): Promise<AnnouncementResponse> {
    return this.announcementsService.createAnnouncement(
      request.authContext!.userId,
      courseId,
      body,
    );
  }

  @Patch('courses/:courseId/announcements/:id')
  async updateAnnouncement(
    @Req() request: Request,
    @Param('courseId') courseId: string,
    @Param('id') id: string,
    @Body() body: UpdateAnnouncementDto,
  ): Promise<AnnouncementResponse> {
    return this.announcementsService.updateAnnouncement(
      request.authContext!.userId,
      courseId,
      id,
      body,
    );
  }

  @Post('courses/:courseId/announcements/:id/publish')
  async publishAnnouncement(
    @Req() request: Request,
    @Param('courseId') courseId: string,
    @Param('id') id: string,
  ): Promise<AnnouncementResponse> {
    return this.announcementsService.publishAnnouncement(
      request.authContext!.userId,
      courseId,
      id,
    );
  }

  @Post('courses/:courseId/announcements/:id/archive')
  async archiveAnnouncement(
    @Req() request: Request,
    @Param('courseId') courseId: string,
    @Param('id') id: string,
  ): Promise<AnnouncementResponse> {
    return this.announcementsService.archiveAnnouncement(
      request.authContext!.userId,
      courseId,
      id,
    );
  }

  // -------------------------------------------------------------------
  // Phase 6 — academy-wide authoring. No extra guard beyond `JwtAuthGuard`
  // (already applied at the class level) — same reasoning as every other
  // route on this controller: the real scoping/authorization happens
  // inside `AnnouncementsService.assertCanManageAcademy` and the RLS
  // policies it runs under, never a route-level academy-scoping guard.
  // -------------------------------------------------------------------

  @Get('academies/:academyId/announcements')
  async getAcademyAnnouncements(
    @Req() request: Request,
    @Param('academyId') academyId: string,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<AnnouncementResponse>> {
    return this.announcementsService.getAcademyAnnouncements(
      request.authContext!.userId,
      academyId,
      query,
    );
  }

  @Post('academies/:academyId/announcements')
  async createAcademyAnnouncement(
    @Req() request: Request,
    @Param('academyId') academyId: string,
    @Body() body: CreateAnnouncementDto,
  ): Promise<AnnouncementResponse> {
    return this.announcementsService.createAcademyAnnouncement(
      request.authContext!.userId,
      academyId,
      body,
    );
  }

  @Patch('academies/:academyId/announcements/:id')
  async updateAcademyAnnouncement(
    @Req() request: Request,
    @Param('academyId') academyId: string,
    @Param('id') id: string,
    @Body() body: UpdateAnnouncementDto,
  ): Promise<AnnouncementResponse> {
    return this.announcementsService.updateAcademyAnnouncement(
      request.authContext!.userId,
      academyId,
      id,
      body,
    );
  }

  @Post('academies/:academyId/announcements/:id/publish')
  async publishAcademyAnnouncement(
    @Req() request: Request,
    @Param('academyId') academyId: string,
    @Param('id') id: string,
  ): Promise<AnnouncementResponse> {
    return this.announcementsService.publishAcademyAnnouncement(
      request.authContext!.userId,
      academyId,
      id,
    );
  }

  @Post('academies/:academyId/announcements/:id/archive')
  async archiveAcademyAnnouncement(
    @Req() request: Request,
    @Param('academyId') academyId: string,
    @Param('id') id: string,
  ): Promise<AnnouncementResponse> {
    return this.announcementsService.archiveAcademyAnnouncement(
      request.authContext!.userId,
      academyId,
      id,
    );
  }

  // -------------------------------------------------------------------
  // Phase 6 — platform-wide authoring. `PlatformOwnerGuard` is the
  // primary authority here (re-checked live against `users.
  // is_platform_owner` on every call — see that guard's own doc
  // comment); the `announcements_platform_manage_*` RLS policies are
  // the backstop, matching this codebase's established "guard decides,
  // RLS independently agrees" discipline.
  // -------------------------------------------------------------------

  @Get('platform/announcements')
  @UseGuards(PlatformOwnerGuard)
  async getPlatformAnnouncements(
    @Req() request: Request,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<AnnouncementResponse>> {
    return this.announcementsService.getPlatformAnnouncements(
      request.authContext!.userId,
      query,
    );
  }

  @Post('platform/announcements')
  @UseGuards(PlatformOwnerGuard)
  async createPlatformAnnouncement(
    @Req() request: Request,
    @Body() body: CreateAnnouncementDto,
  ): Promise<AnnouncementResponse> {
    return this.announcementsService.createPlatformAnnouncement(
      request.authContext!.userId,
      body,
    );
  }

  @Patch('platform/announcements/:id')
  @UseGuards(PlatformOwnerGuard)
  async updatePlatformAnnouncement(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: UpdateAnnouncementDto,
  ): Promise<AnnouncementResponse> {
    return this.announcementsService.updatePlatformAnnouncement(
      request.authContext!.userId,
      id,
      body,
    );
  }

  @Post('platform/announcements/:id/publish')
  @UseGuards(PlatformOwnerGuard)
  async publishPlatformAnnouncement(
    @Req() request: Request,
    @Param('id') id: string,
  ): Promise<AnnouncementResponse> {
    return this.announcementsService.publishPlatformAnnouncement(
      request.authContext!.userId,
      id,
    );
  }

  @Post('platform/announcements/:id/archive')
  @UseGuards(PlatformOwnerGuard)
  async archivePlatformAnnouncement(
    @Req() request: Request,
    @Param('id') id: string,
  ): Promise<AnnouncementResponse> {
    return this.announcementsService.archivePlatformAnnouncement(
      request.authContext!.userId,
      id,
    );
  }
}
