/**
 * ForumsController — `courses/:id/forum/*`, matching `ForumService`'s
 * (frontend) `protected readonly resource = 'courses'` nesting exactly.
 * `JwtAuthGuard` alone — see `InstructorController`'s doc comment.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { ForumsService } from '../services/forums.service';
import { CreateForumThreadDto } from '../dto/create-forum-thread.dto';
import { CreateForumReplyDto } from '../dto/create-forum-reply.dto';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type {
  ForumReplyResponse,
  ForumResponse,
  ForumThreadResponse,
} from '../dto/forum.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { SubscriptionScope } from '../../plans/decorators/subscription-scope.decorator';

@Controller('courses')
@UseGuards(JwtAuthGuard)
export class ForumsController {
  constructor(private readonly forumsService: ForumsService) {}

  @Get(':id/forum')
  async getForum(
    @Req() request: Request,
    @Param('id') courseId: string,
  ): Promise<ForumResponse> {
    return this.forumsService.getForum(request.authContext!.userId, courseId);
  }

  @Get(':id/forum/threads')
  async getThreads(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<ForumThreadResponse>> {
    return this.forumsService.getThreads(request.authContext!.userId, courseId, query);
  }

  @Get(':id/forum/threads/:threadId')
  async getThread(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('threadId') threadId: string,
  ): Promise<ForumThreadResponse> {
    return this.forumsService.getThread(request.authContext!.userId, courseId, threadId);
  }

  @Get(':id/forum/threads/:threadId/replies')
  async getReplies(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('threadId') threadId: string,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<ForumReplyResponse>> {
    return this.forumsService.getReplies(
      request.authContext!.userId,
      courseId,
      threadId,
      query,
    );
  }

  @Post(':id/forum/threads')
  async createThread(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Body() body: CreateForumThreadDto,
  ): Promise<ForumThreadResponse> {
    return this.forumsService.createThread(request.authContext!.userId, courseId, body);
  }

  @Post(':id/forum/threads/:threadId/replies')
  async createReply(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('threadId') threadId: string,
    @Body() body: CreateForumReplyDto,
  ): Promise<ForumReplyResponse> {
    return this.forumsService.createReply(
      request.authContext!.userId,
      courseId,
      threadId,
      body,
    );
  }

  @Post(':id/forum/threads/:threadId/pin')
  // Launch Stabilization A1 (D1) — staff authoring/moderation; never from
  // an academy-website session.
  @UseGuards(ManagementSurfaceGuard)
  @SubscriptionScope({ kind: 'course', param: 'id' })
  async pinThread(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('threadId') threadId: string,
  ): Promise<ForumThreadResponse> {
    return this.forumsService.pinThread(request.authContext!.userId, courseId, threadId);
  }

  @Post(':id/forum/threads/:threadId/unpin')
  // Launch Stabilization A1 (D1) — staff authoring/moderation; never from
  // an academy-website session.
  @UseGuards(ManagementSurfaceGuard)
  @SubscriptionScope({ kind: 'course', param: 'id' })
  async unpinThread(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('threadId') threadId: string,
  ): Promise<ForumThreadResponse> {
    return this.forumsService.unpinThread(
      request.authContext!.userId,
      courseId,
      threadId,
    );
  }

  @Post(':id/forum/threads/:threadId/lock')
  // Launch Stabilization A1 (D1) — staff authoring/moderation; never from
  // an academy-website session.
  @UseGuards(ManagementSurfaceGuard)
  @SubscriptionScope({ kind: 'course', param: 'id' })
  async lockThread(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('threadId') threadId: string,
  ): Promise<ForumThreadResponse> {
    return this.forumsService.lockThread(request.authContext!.userId, courseId, threadId);
  }

  @Post(':id/forum/threads/:threadId/unlock')
  // Launch Stabilization A1 (D1) — staff authoring/moderation; never from
  // an academy-website session.
  @UseGuards(ManagementSurfaceGuard)
  @SubscriptionScope({ kind: 'course', param: 'id' })
  async unlockThread(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('threadId') threadId: string,
  ): Promise<ForumThreadResponse> {
    return this.forumsService.unlockThread(
      request.authContext!.userId,
      courseId,
      threadId,
    );
  }
}
