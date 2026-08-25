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
}
