/**
 * AssignmentsController — `courses/:id/assignments*` (master plan §10,
 * P6). Same flat, course-id-scoped shape as `CourseProgressController`/
 * `QuizzesController`.
 *
 * `getSubmission` bypasses Nest's default response handling via `@Res()`
 * — see `EnrollmentsController.getForCourse`'s identical doc comment for
 * why: `AssignmentService.getSubmission`'s real contract is
 * `AssignmentSubmission | null`, but Nest's router collapses a returned
 * `null` into an empty body (`isNil` check in `@nestjs/platform-express`),
 * not the JSON literal `null` the frontend type expects.
 */
import { Body, Controller, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { AssignmentsService } from '../services/assignments.service';
import { CreateAssignmentSubmissionDto } from '../dto/create-assignment-submission.dto';
import type { AssignmentResponse } from '../dto/assignment.contract';
import type { AssignmentSubmissionResponse } from '../dto/assignment-submission.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('courses')
@UseGuards(JwtAuthGuard)
export class AssignmentsController {
  constructor(private readonly assignmentsService: AssignmentsService) {}

  @Get(':id/assignments')
  async getAssignments(
    @Req() request: Request,
    @Param('id') courseId: string,
  ): Promise<PaginatedResult<AssignmentResponse>> {
    return this.assignmentsService.getAssignments(request.authContext!.userId, courseId);
  }

  @Get(':id/assignments/:assignmentId')
  async getAssignment(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('assignmentId') assignmentId: string,
  ): Promise<AssignmentResponse> {
    return this.assignmentsService.getAssignment(
      request.authContext!.userId,
      courseId,
      assignmentId,
    );
  }

  @Get(':id/assignments/:assignmentId/submission')
  async getSubmission(
    @Req() request: Request,
    @Res() response: Response,
    @Param('id') courseId: string,
    @Param('assignmentId') assignmentId: string,
  ): Promise<void> {
    const result = await this.assignmentsService.getSubmission(
      request.authContext!.userId,
      courseId,
      assignmentId,
    );
    response.status(200).json(result);
  }

  @Post(':id/assignments/:assignmentId/submission')
  async submitAssignment(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('assignmentId') assignmentId: string,
    @Body() body: CreateAssignmentSubmissionDto,
  ): Promise<AssignmentSubmissionResponse> {
    return this.assignmentsService.submitAssignment(
      request.authContext!.userId,
      courseId,
      assignmentId,
      body,
    );
  }
}
