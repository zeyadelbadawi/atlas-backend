/**
 * InstructorController — `instructor/*` (master plan §10, P7). Flat
 * `instructor` resource, matching `InstructorService`'s (frontend)
 * `protected readonly resource = 'instructor'` exactly. `JwtAuthGuard`
 * alone — no academy-scoping guard, matching `LearningModule`'s (P6)
 * identical reasoning: the real scoping happens inside
 * `InstructorService`, resolved from a real `course_instructors` row on
 * every request, never trusted from the URL.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { InstructorService } from '../services/instructor.service';
import { GradeSubmissionDto } from '../dto/grade-submission.dto';
import { QuizReviewService } from '../services/quiz-review.service';
import {
  GradeQuizAttemptDto,
  InvalidateQuizAttemptDto,
  QuizStudentOverrideDto,
} from '../../learning/dto/quiz-attempt-engine.dto';
import type {
  QuizAttemptReviewResponse,
  QuizStudentOverrideResponse,
} from '../dto/quiz-review.contract';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type {
  AssignmentSubmissionReviewResponse,
  InstructorCourseOverviewResponse,
  InstructorDashboardMetricsResponse,
  InstructorStudentProgressResponse,
  InstructorStudentResponse,
  QuizAttemptSummaryResponse,
  TeachingCourseResponse,
} from '../dto/instructor.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

// P64 Phase 1 — the review surface is authorized for course instructors AND
// the owning academy's owner/administrator/manager (`assertCanReviewCourse`),
// so the honest prefix is `review`. `instructor` stays as an alias for one
// release so in-flight clients keep working.
@Controller(['instructor', 'review'])
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard)
export class InstructorController {
  constructor(
    private readonly instructorService: InstructorService,
    private readonly quizReview: QuizReviewService,
  ) {}

  @Get('dashboard')
  async getDashboard(
    @Req() request: Request,
  ): Promise<InstructorDashboardMetricsResponse> {
    return this.instructorService.getDashboard(request.authContext!.userId);
  }

  @Get('courses')
  async getTeachingCourses(
    @Req() request: Request,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<TeachingCourseResponse>> {
    return this.instructorService.getTeachingCourses(request.authContext!.userId, query);
  }

  @Get('courses/:id')
  async getCourseOverview(
    @Req() request: Request,
    @Param('id') courseId: string,
  ): Promise<InstructorCourseOverviewResponse> {
    return this.instructorService.getCourseOverview(
      request.authContext!.userId,
      courseId,
    );
  }

  @Get('courses/:id/students')
  async getCourseStudents(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<InstructorStudentResponse>> {
    return this.instructorService.getCourseStudents(
      request.authContext!.userId,
      courseId,
      query,
    );
  }

  @Get('courses/:id/students/:studentId')
  async getStudentProgress(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('studentId') studentId: string,
  ): Promise<InstructorStudentProgressResponse> {
    return this.instructorService.getStudentProgress(
      request.authContext!.userId,
      courseId,
      studentId,
    );
  }

  @Get('courses/:id/quizzes/:quizId/attempts')
  async getQuizAttempts(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('quizId') quizId: string,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<QuizAttemptSummaryResponse>> {
    return this.instructorService.getQuizAttempts(
      request.authContext!.userId,
      courseId,
      quizId,
      query,
    );
  }

  @Get('courses/:id/assignments/:assignmentId/submissions')
  async getAssignmentSubmissions(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('assignmentId') assignmentId: string,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<AssignmentSubmissionReviewResponse>> {
    return this.instructorService.getAssignmentSubmissions(
      request.authContext!.userId,
      courseId,
      assignmentId,
      query,
    );
  }

  @Get('courses/:id/assignments/:assignmentId/submissions/:submissionId')
  async getSubmission(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('assignmentId') assignmentId: string,
    @Param('submissionId') submissionId: string,
  ): Promise<AssignmentSubmissionReviewResponse> {
    return this.instructorService.getSubmission(
      request.authContext!.userId,
      courseId,
      assignmentId,
      submissionId,
    );
  }

  @Post('courses/:id/assignments/:assignmentId/submissions/:submissionId/grade')
  async gradeSubmission(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('assignmentId') assignmentId: string,
    @Param('submissionId') submissionId: string,
    @Body() body: GradeSubmissionDto,
  ): Promise<AssignmentSubmissionReviewResponse> {
    return this.instructorService.gradeSubmission(
      request.authContext!.userId,
      courseId,
      assignmentId,
      submissionId,
      body,
    );
  }
  // --- P64 Phase 3 — quiz review (§E.7) -------------------------------------

  @Get('courses/:id/quizzes/:quizId/attempts/:attemptId')
  async getQuizAttempt(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('quizId') quizId: string,
    @Param('attemptId') attemptId: string,
  ): Promise<QuizAttemptReviewResponse> {
    return this.quizReview.getAttempt(
      request.authContext!.userId,
      courseId,
      quizId,
      attemptId,
    );
  }

  @Post('courses/:id/quizzes/:quizId/attempts/:attemptId/grade')
  @HttpCode(200)
  async gradeQuizAttempt(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('quizId') quizId: string,
    @Param('attemptId') attemptId: string,
    @Body() body: GradeQuizAttemptDto,
  ): Promise<QuizAttemptReviewResponse> {
    return this.quizReview.gradeAttempt(
      request.authContext!.userId,
      courseId,
      quizId,
      attemptId,
      body,
    );
  }

  @Post('courses/:id/quizzes/:quizId/attempts/:attemptId/invalidate')
  @HttpCode(200)
  async invalidateQuizAttempt(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('quizId') quizId: string,
    @Param('attemptId') attemptId: string,
    @Body() body: InvalidateQuizAttemptDto,
  ): Promise<QuizAttemptReviewResponse> {
    return this.quizReview.invalidateAttempt(
      request.authContext!.userId,
      courseId,
      quizId,
      attemptId,
      body,
    );
  }

  @Get('courses/:id/quizzes/:quizId/overrides')
  async listQuizOverrides(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('quizId') quizId: string,
  ): Promise<QuizStudentOverrideResponse[]> {
    return this.quizReview.listOverrides(request.authContext!.userId, courseId, quizId);
  }

  @Put('courses/:id/quizzes/:quizId/overrides')
  async upsertQuizOverride(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('quizId') quizId: string,
    @Body() body: QuizStudentOverrideDto,
  ): Promise<QuizStudentOverrideResponse> {
    return this.quizReview.upsertOverride(
      request.authContext!.userId,
      courseId,
      quizId,
      body,
    );
  }

  @Delete('courses/:id/quizzes/:quizId/overrides/:studentId')
  @HttpCode(204)
  async deleteQuizOverride(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('quizId') quizId: string,
    @Param('studentId') studentId: string,
  ): Promise<void> {
    await this.quizReview.deleteOverride(
      request.authContext!.userId,
      courseId,
      quizId,
      studentId,
    );
  }

  @Get('courses/:id/quizzes/:quizId/integrity.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Cache-Control', 'private, no-store')
  async integrityCsv(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('quizId') quizId: string,
  ): Promise<string> {
    return this.quizReview.integrityCsv(request.authContext!.userId, courseId, quizId);
  }
}
