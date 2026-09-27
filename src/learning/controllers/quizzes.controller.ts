/**
 * Quizzes — learner and authoring surfaces under `/courses/:id/quizzes`.
 *
 * Every handler is authenticated only at the route; the real authorization
 * (enrollment, authoring rights, attempt ownership) is inside the services,
 * re-established per request under the caller's RLS user context.
 *
 * P64 Phase 3 — the attempt lifecycle is served by `QuizAttemptEngineService`:
 *   POST   …/attempts                       start or resume (returns the attempt)
 *   GET    …/attempts/:attemptId            the session: paper, saved answers, server clock, deadline
 *   PUT    …/attempts/:attemptId/answers    autosave (monotonic revision)
 *   POST   …/attempts/:attemptId/submit     submit (idempotent; partial allowed under engine v2)
 *   POST   …/attempts/:attemptId/events     integrity events (batched ≤ 50)
 *   GET    …/attempts/:attemptId/results    results by disclosure policy
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { QuizzesService } from '../services/quizzes.service';
import { QuizAttemptEngineService } from '../services/quiz-attempt-engine.service';
import { CreateQuizDto } from '../dto/create-quiz.dto';
import { UpdateQuizDto } from '../dto/update-quiz.dto';
import {
  RecordQuizAttemptEventsDto,
  SaveQuizAnswersDto,
  SubmitQuizAttemptV2Dto,
} from '../dto/quiz-attempt-engine.dto';
import type { QuizResponse } from '../dto/quiz.contract';
import type { QuizAuthoringResponse } from '../dto/quiz-authoring.contract';
import type { QuizAttemptResponse } from '../dto/quiz-attempt.contract';
import type {
  QuizAttemptResultsResponse,
  QuizAttemptSessionResponse,
  RecordEventsResponse,
  SaveAnswersResponse,
} from '../dto/quiz-attempt-session.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('courses')
@UseGuards(JwtAuthGuard)
export class QuizzesController {
  constructor(
    private readonly quizzesService: QuizzesService,
    private readonly engine: QuizAttemptEngineService,
  ) {}

  @Get(':id/quizzes')
  async getQuizzes(
    @Req() request: Request,
    @Param('id') courseId: string,
  ): Promise<PaginatedResult<QuizResponse>> {
    return this.quizzesService.getQuizzes(request.authContext!.userId, courseId);
  }

  @Get(':id/quizzes/authoring')
  // Launch Stabilization A1 (D1) — staff authoring/moderation; never from
  // an academy-website session.
  @UseGuards(ManagementSurfaceGuard)
  async getQuizzesForAuthoring(
    @Req() request: Request,
    @Param('id') courseId: string,
  ): Promise<PaginatedResult<QuizResponse>> {
    return this.quizzesService.getQuizzesForAuthoring(
      request.authContext!.userId,
      courseId,
    );
  }

  @Post(':id/quizzes')
  // Launch Stabilization A1 (D1) — staff authoring/moderation; never from
  // an academy-website session.
  @UseGuards(ManagementSurfaceGuard)
  async createQuiz(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Body() body: CreateQuizDto,
  ): Promise<QuizAuthoringResponse> {
    return this.quizzesService.createQuiz(request.authContext!.userId, courseId, body);
  }

  @Get(':id/quizzes/:quizId')
  async getQuiz(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('quizId') quizId: string,
  ): Promise<QuizResponse> {
    return this.quizzesService.getQuiz(request.authContext!.userId, courseId, quizId);
  }

  @Get(':id/quizzes/:quizId/authoring')
  // Launch Stabilization A1 (D1) — staff authoring/moderation; never from
  // an academy-website session.
  @UseGuards(ManagementSurfaceGuard)
  async getQuizForAuthoring(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('quizId') quizId: string,
  ): Promise<QuizAuthoringResponse> {
    return this.quizzesService.getQuizForAuthoring(
      request.authContext!.userId,
      courseId,
      quizId,
    );
  }

  @Patch(':id/quizzes/:quizId')
  // Launch Stabilization A1 (D1) — staff authoring/moderation; never from
  // an academy-website session.
  @UseGuards(ManagementSurfaceGuard)
  async updateQuiz(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('quizId') quizId: string,
    @Body() body: UpdateQuizDto,
  ): Promise<QuizAuthoringResponse> {
    return this.quizzesService.updateQuiz(
      request.authContext!.userId,
      courseId,
      quizId,
      body,
    );
  }

  @Delete(':id/quizzes/:quizId')
  // Launch Stabilization A1 (D1) — staff authoring/moderation; never from
  // an academy-website session.
  @UseGuards(ManagementSurfaceGuard)
  @HttpCode(204)
  async deleteQuiz(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('quizId') quizId: string,
  ): Promise<void> {
    await this.quizzesService.deleteQuiz(request.authContext!.userId, courseId, quizId);
  }

  @Get(':id/quizzes/:quizId/attempts')
  async getAttempts(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('quizId') quizId: string,
  ): Promise<PaginatedResult<QuizAttemptResponse>> {
    return this.quizzesService.getAttempts(request.authContext!.userId, courseId, quizId);
  }

  @Post(':id/quizzes/:quizId/attempts')
  @HttpCode(201)
  async startAttempt(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('quizId') quizId: string,
  ): Promise<QuizAttemptResponse> {
    return this.engine.start(request.authContext!.userId, courseId, quizId);
  }

  @Get(':id/quizzes/:quizId/attempts/:attemptId')
  async getAttemptSession(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('quizId') quizId: string,
    @Param('attemptId') attemptId: string,
  ): Promise<QuizAttemptSessionResponse> {
    return this.engine.getSession(
      request.authContext!.userId,
      courseId,
      quizId,
      attemptId,
    );
  }

  @Put(':id/quizzes/:quizId/attempts/:attemptId/answers')
  async saveAnswers(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('quizId') quizId: string,
    @Param('attemptId') attemptId: string,
    @Body() body: SaveQuizAnswersDto,
  ): Promise<SaveAnswersResponse> {
    return this.engine.saveAnswers(
      request.authContext!.userId,
      courseId,
      quizId,
      attemptId,
      body,
    );
  }

  @Post(':id/quizzes/:quizId/attempts/:attemptId/submit')
  async submitAttempt(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('quizId') quizId: string,
    @Param('attemptId') attemptId: string,
    @Body() body: SubmitQuizAttemptV2Dto,
  ): Promise<QuizAttemptResponse> {
    return this.engine.submit(
      request.authContext!.userId,
      courseId,
      quizId,
      attemptId,
      body,
    );
  }

  @Post(':id/quizzes/:quizId/attempts/:attemptId/events')
  @HttpCode(200)
  async recordEvents(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('quizId') quizId: string,
    @Param('attemptId') attemptId: string,
    @Body() body: RecordQuizAttemptEventsDto,
  ): Promise<RecordEventsResponse> {
    return this.engine.recordEvents(
      request.authContext!.userId,
      courseId,
      quizId,
      attemptId,
      body,
    );
  }

  @Get(':id/quizzes/:quizId/attempts/:attemptId/results')
  async getResults(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('quizId') quizId: string,
    @Param('attemptId') attemptId: string,
  ): Promise<QuizAttemptResultsResponse> {
    return this.engine.getResults(
      request.authContext!.userId,
      courseId,
      quizId,
      attemptId,
    );
  }
}
