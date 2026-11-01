/**
 * `learning/notes*`, `learning/streak` — the learner's own notes and study
 * days, for the Atlas mobile app. Scoped by the academy the request serves,
 * exactly like `LearnerDashboardController` (host first; the `academyId`
 * query only where no host resolves, and only for the session's academy).
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { AcademySurfaceService } from '../identity/services/academy-surface.service';
import { assertSessionServesHostAcademy } from '../learning/dto/learning-request.util';
import { LearnerNotesService } from './learner-notes.service';
import { StudyDaysService } from './study-days.service';
import {
  PutLearnerNoteDto,
  StreakQueryDto,
  type LearnerNoteResponse,
  type PutLearnerNoteResponse,
  type StudyDaysResponse,
} from './dto/learner-sync.dto';

@Controller('learning')
@UseGuards(JwtAuthGuard)
export class LearnerSyncController {
  constructor(
    private readonly notes: LearnerNotesService,
    private readonly studyDays: StudyDaysService,
    private readonly academySurface: AcademySurfaceService,
  ) {}

  @Get('notes')
  async listNotes(@Req() request: Request): Promise<readonly LearnerNoteResponse[]> {
    const academyId = await this.academyOf(request);
    return this.notes.list(request.authContext!.userId, academyId);
  }

  @Put('notes/:lessonId')
  @Throttle({ default: { limit: 300, ttl: 3_600_000 } })
  async putNote(
    @Req() request: Request,
    @Param('lessonId', new ParseUUIDPipe()) lessonId: string,
    @Body() body: PutLearnerNoteDto,
  ): Promise<PutLearnerNoteResponse> {
    const academyId = await this.academyOf(request);
    return this.notes.put(request.authContext!.userId, academyId, lessonId, body);
  }

  @Get('streak')
  async streak(
    @Req() request: Request,
    @Query() query: StreakQueryDto,
  ): Promise<StudyDaysResponse> {
    const academyId = await this.academyOf(request);
    return this.studyDays.days(request.authContext!.userId, academyId, query.tz);
  }

  private async academyOf(request: Request): Promise<string> {
    const hostAcademyId = await this.academySurface.resolveHostAcademyId(
      request.hostname,
    );
    if (hostAcademyId) {
      assertSessionServesHostAcademy(request, hostAcademyId);
      return hostAcademyId;
    }
    const fallback = (request.query as Record<string, unknown>).academyId;
    if (typeof fallback === 'string' && fallback.length > 0) {
      assertSessionServesHostAcademy(request, fallback);
      return fallback;
    }
    throw new BadRequestException({ messageKey: 'errors.academy.hostUnresolved' });
  }
}
