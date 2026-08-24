/**
 * QuizzesController — `courses/:id/quizzes*` (master plan §10, P6). Same
 * flat, course-id-scoped shape as `CourseProgressController`.
 */
import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { QuizzesService } from '../services/quizzes.service';
import { SubmitQuizAttemptDto } from '../dto/submit-quiz-attempt.dto';
import type { QuizResponse } from '../dto/quiz.contract';
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

  @Get(':id/quizzes/:quizId')
  async getQuiz(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('quizId') quizId: string,
  ): Promise<QuizResponse> {
    return this.quizzesService.getQuiz(request.authContext!.userId, courseId, quizId);
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
