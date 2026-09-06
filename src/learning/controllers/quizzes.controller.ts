/**
 * QuizzesController — `courses/:id/quizzes*` (master plan §10, P6; §22/§24
 * authoring, Phase 4/P24). Same flat, course-id-scoped shape as
 * `CourseProgressController`.
 *
 * Route declaration order matters, exactly like
 * `CourseCurriculumController`'s own documented precedent: the literal
 * `quizzes/authoring` route is declared BEFORE the parameterized
 * `quizzes/:quizId` route, or Nest would match "authoring" as a `quizId`
 * value for the wrong handler.
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
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { QuizzesService } from '../services/quizzes.service';
import { SubmitQuizAttemptDto } from '../dto/submit-quiz-attempt.dto';
import { CreateQuizDto } from '../dto/create-quiz.dto';
import { UpdateQuizDto } from '../dto/update-quiz.dto';
import type { QuizResponse } from '../dto/quiz.contract';
import type { QuizAuthoringResponse } from '../dto/quiz-authoring.contract';
import type { QuizAttemptResponse } from '../dto/quiz-attempt.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('courses')
@UseGuards(JwtAuthGuard)
export class QuizzesController {
  constructor(private readonly quizzesService: QuizzesService) {}

  @Get(':id/quizzes')
  async getQuizzes(
    @Req() request: Request,
    @Param('id') courseId: string,
  ): Promise<PaginatedResult<QuizResponse>> {
    return this.quizzesService.getQuizzes(request.authContext!.userId, courseId);
  }

  /** Phase 4 — every status (draft + published), author-only. Declared before `:quizId` — see this class's own doc comment. */
  @Get(':id/quizzes/authoring')
  async getQuizzesForAuthoring(
    @Req() request: Request,
    @Param('id') courseId: string,
  ): Promise<PaginatedResult<QuizResponse>> {
    return this.quizzesService.getQuizzesForAuthoring(
      request.authContext!.userId,
      courseId,
    );
  }

  /** Phase 4 — create a quiz with its complete question/option set. */
  @Post(':id/quizzes')
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

  /** Phase 4 — the authoring counterpart of `getQuiz`, including `isCorrect`. Author-only. */
  @Get(':id/quizzes/:quizId/authoring')
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

  /** Phase 4 — update a quiz. `questions`, when present, replaces the whole question/option set — see `UpdateQuizDto`'s doc comment. */
  @Patch(':id/quizzes/:quizId')
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

  /** Phase 4 — real SQL DELETE, cascades to questions/options/attempts. */
  @Delete(':id/quizzes/:quizId')
  @HttpCode(204)
  async deleteQuiz(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('quizId') quizId: string,
  ): Promise<void> {
    return this.quizzesService.deleteQuiz(request.authContext!.userId, courseId, quizId);
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
  async startAttempt(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('quizId') quizId: string,
  ): Promise<QuizAttemptResponse> {
    return this.quizzesService.startAttempt(
      request.authContext!.userId,
      courseId,
      quizId,
    );
  }

  @Post(':id/quizzes/:quizId/attempts/:attemptId/submit')
  async submitAttempt(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('quizId') quizId: string,
    @Param('attemptId') attemptId: string,
    @Body() body: SubmitQuizAttemptDto,
  ): Promise<QuizAttemptResponse> {
    return this.quizzesService.submitAttempt(
      request.authContext!.userId,
      courseId,
      quizId,
      attemptId,
      body,
    );
  }
}
