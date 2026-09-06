/**
 * AssignmentsController — `courses/:id/assignments*` (master plan §10,
 * P6; §22/§24 authoring, Phase 4/P24). Same flat, course-id-scoped shape
 * as `CourseProgressController`/`QuizzesController`.
 *
 * Route declaration order matters — see `QuizzesController`'s identical
 * doc comment: the literal `assignments/authoring` route is declared
 * before the parameterized `assignments/:assignmentId` route.
 *
 * `getSubmission` bypasses Nest's default response handling via `@Res()`
 * — see `EnrollmentsController.getForCourse`'s identical doc comment for
 * why: `AssignmentService.getSubmission`'s real contract is
 * `AssignmentSubmission | null`, but Nest's router collapses a returned
 * `null` into an empty body (`isNil` check in `@nestjs/platform-express`),
 * not the JSON literal `null` the frontend type expects.
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
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { AssignmentsService } from '../services/assignments.service';
import { CreateAssignmentSubmissionDto } from '../dto/create-assignment-submission.dto';
import { CreateAssignmentDto } from '../dto/create-assignment.dto';
import { UpdateAssignmentDto } from '../dto/update-assignment.dto';
import { UploadMediaAssetDto } from '../../media/dto/upload-media-asset.dto';
import type { AssignmentResponse } from '../dto/assignment.contract';
import type { AssignmentSubmissionResponse } from '../dto/assignment-submission.contract';
import type { MediaAssetResponse } from '../../media/dto/media-asset.contract';
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

  /** Phase 4 — every status (draft + published), author-only. Declared before `:assignmentId` — see this class's own doc comment. */
  @Get(':id/assignments/authoring')
  async getAssignmentsForAuthoring(
    @Req() request: Request,
    @Param('id') courseId: string,
  ): Promise<PaginatedResult<AssignmentResponse>> {
    return this.assignmentsService.getAssignmentsForAuthoring(
      request.authContext!.userId,
      courseId,
    );
  }

  /** Phase 4 — create an assignment. */
  @Post(':id/assignments')
  async createAssignment(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Body() body: CreateAssignmentDto,
  ): Promise<AssignmentResponse> {
    return this.assignmentsService.createAssignment(
      request.authContext!.userId,
      courseId,
      body,
    );
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

  /** Phase 4 — the authoring counterpart of `getAssignment` (any status). Author-only. */
  @Get(':id/assignments/:assignmentId/authoring')
  async getAssignmentForAuthoring(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('assignmentId') assignmentId: string,
  ): Promise<AssignmentResponse> {
    return this.assignmentsService.getAssignmentForAuthoring(
      request.authContext!.userId,
      courseId,
      assignmentId,
    );
  }

  /** Phase 4 — update an assignment. */
  @Patch(':id/assignments/:assignmentId')
  async updateAssignment(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('assignmentId') assignmentId: string,
    @Body() body: UpdateAssignmentDto,
  ): Promise<AssignmentResponse> {
    return this.assignmentsService.updateAssignment(
      request.authContext!.userId,
      courseId,
      assignmentId,
      body,
    );
  }

  /** Phase 4 — real SQL DELETE, cascades to submissions. */
  @Delete(':id/assignments/:assignmentId')
  @HttpCode(204)
  async deleteAssignment(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('assignmentId') assignmentId: string,
  ): Promise<void> {
    return this.assignmentsService.deleteAssignment(
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

  /**
   * Phase 4 — uploads a real file for the current student's upcoming
   * submission through the existing R2 media pipeline, returning its
   * real, permanent URL to be passed as `attachmentUrl` in the
   * `submitAssignment` call that follows. `assignmentId` is accepted for
   * a symmetric, self-documenting URL only — the underlying check is a
   * real active enrollment in `:id` (the course), not a per-assignment
   * fact; see `AssignmentsService.uploadSubmissionAttachment`'s own doc
   * comment.
   */
  @Post(':id/assignments/:assignmentId/submission/attachment')
  async uploadSubmissionAttachment(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Body() body: UploadMediaAssetDto,
  ): Promise<MediaAssetResponse> {
    return this.assignmentsService.uploadSubmissionAttachment(
      request.authContext!.userId,
      courseId,
      body,
    );
  }
}
