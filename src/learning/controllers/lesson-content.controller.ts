/**
 * The learner content path — `learning/courses/:id/...` (master plan
 * Phase 2 §L).
 *
 * MOUNTED UNDER `learning/`, NOT `courses/`, deliberately. The existing
 * `courses/:id/*` routes are the pre-P64 shape: an authenticated caller,
 * a course id, and whatever that course will give them. These endpoints
 * are the LEARNER surface — they answer with signed credentials, they
 * take a device lease, and they are scoped by the request host — and
 * giving them their own prefix keeps the two from being confused for one
 * another by a future reader or a future guard.
 *
 * `GET …/content` IS NOT AUTHENTICATED AT THE GUARD LEVEL, on purpose. A
 * PREVIEW lesson must open for a prospective student who has no account
 * yet (§V: "preview lessons open without enrollment"), so identity is
 * resolved inside `LessonContentService` and required for every path
 * except that one. Everything else here requires a session.
 *
 * NO-STORE ON EVERY GRANT (§I). The response carries short-lived signed
 * URLs; a shared cache holding a copy would outlive the credential inside
 * it and hand the next requester somebody else's grant.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../../identity/guards/optional-jwt-auth.guard';
import { AcademySurfaceService } from '../../identity/services/academy-surface.service';
import { LessonContentService } from '../services/lesson-content.service';
import { CourseSequenceService } from '../services/course-sequence.service';
import { PlaybackService } from '../services/playback.service';
import { CourseProgressService } from '../services/course-progress.service';
import {
  assertSessionServesHostAcademy,
  learningRequestContext,
} from '../dto/learning-request.util';
import { LearningMetricsService } from '../../observability/metrics/learning-metrics.service';
import { PlaybackHeartbeatDto, ReleaseLeaseDto } from '../dto/playback.dto';
import { LessonOpOrderingDto } from '../dto/complete-lesson.dto';
import type { LessonContentGrantResponse } from '../dto/lesson-content.contract';
import type { CourseSequenceResponse } from '../dto/course-sequence.contract';
import type { PlaybackHeartbeatResponse } from '../services/playback.service';
import type { CourseProgressResponse } from '../dto/course-progress.contract';

@Controller('learning/courses')
export class LessonContentController {
  constructor(
    private readonly lessonContentService: LessonContentService,
    private readonly courseSequenceService: CourseSequenceService,
    private readonly playbackService: PlaybackService,
    private readonly courseProgressService: CourseProgressService,
    private readonly academySurfaceService: AcademySurfaceService,
    private readonly metrics: LearningMetricsService,
  ) {}

  @Get(':id/lessons/:lessonId/content')
  @UseGuards(OptionalJwtAuthGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async getContent(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('id') courseId: string,
    @Param('lessonId') lessonId: string,
  ): Promise<LessonContentGrantResponse> {
    const hostAcademyId = await this.academySurfaceService.resolveHostAcademyId(
      request.hostname,
    );
    assertSessionServesHostAcademy(request, hostAcademyId);
    return this.lessonContentService.getContent(courseId, lessonId, {
      ...learningRequestContext(request, response),
      hostAcademyId,
    });
  }

  /**
   * Re-issues a grant for a lesson already in play (§L).
   *
   * MANDATORY FOR THE NORMAL TIER, not an optimisation. A Normal-tier
   * credential lives ten minutes by design — that short life is the only
   * thing enforcing revocation latency — so a 90-minute lesson cannot be
   * served by one credential. The player refreshes silently; finding D-3
   * was the bug where a grant claimed two hours for a ten-minute URL and
   * the player had no reason to refresh at all.
   *
   * It is the SAME decision as the initial grant, not a cheaper one: every
   * one of the seven conditions is re-checked, so an enrollment revoked
   * mid-lesson stops the next refresh rather than being noticed at the
   * next login. That is what makes "revocable before expiry" true.
   */
  @Post(':id/lessons/:lessonId/playback/refresh')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async refreshGrant(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('id') courseId: string,
    @Param('lessonId') lessonId: string,
  ): Promise<LessonContentGrantResponse> {
    const hostAcademyId = await this.academySurfaceService.resolveHostAcademyId(
      request.hostname,
    );
    assertSessionServesHostAcademy(request, hostAcademyId);
    const grant = await this.lessonContentService.getContent(courseId, lessonId, {
      ...learningRequestContext(request, response),
      hostAcademyId,
    });
    // §U — the Normal tier's expected refresh load, and the series that
    // would reveal a TTL misconfiguration as a spike rather than as a
    // support ticket.
    this.metrics.recordGrantRefresh(grant.protection.tier);
    return grant;
  }

  @Get(':id/sequence')
  @UseGuards(JwtAuthGuard)
  async getSequence(
    @Req() request: Request,
    @Param('id') courseId: string,
  ): Promise<CourseSequenceResponse> {
    return this.courseSequenceService.getSequence(request.authContext!.userId, courseId);
  }

  @Post(':id/playback')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  async heartbeat(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Body() body: PlaybackHeartbeatDto,
  ): Promise<PlaybackHeartbeatResponse> {
    return this.playbackService.recordHeartbeat(request.authContext!.userId, courseId, {
      lessonId: body.lessonId,
      positionSeconds: body.positionSeconds,
      leaseId: body.leaseId,
    });
  }

  /**
   * Releases the lease when the learner deliberately leaves the player.
   *
   * Best-effort and never required: the lease expires on its own after 60
   * seconds, which is what makes a crashed browser recoverable. This just
   * makes the handover immediate when the learner did close the tab
   * properly.
   */
  @Post(':id/playback/release')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async releaseLease(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Body() body: ReleaseLeaseDto,
  ): Promise<void> {
    await this.playbackService.releaseLease(
      request.authContext!.userId,
      courseId,
      body.leaseId,
    );
  }

  @Delete(':id/progress/complete-lesson/:lessonId')
  @UseGuards(JwtAuthGuard)
  async undoCompleteLesson(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('lessonId') lessonId: string,
    // Academy offline work — optional `?opId=&clientOpAt=` ordering stamp.
    @Query() ordering: LessonOpOrderingDto,
  ): Promise<CourseProgressResponse & { readonly applied?: boolean }> {
    return this.courseProgressService.undoCompleteLesson(
      request.authContext!.userId,
      courseId,
      lessonId,
      ordering,
    );
  }
}
