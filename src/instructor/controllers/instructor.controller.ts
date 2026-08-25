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
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { InstructorService } from '../services/instructor.service';
import { GradeSubmissionDto } from '../dto/grade-submission.dto';
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

@Controller('instructor')
@UseGuards(JwtAuthGuard)
export class InstructorController {
  constructor(private readonly instructorService: InstructorService) {}

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
}
