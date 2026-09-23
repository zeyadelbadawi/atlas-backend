/**
 * CourseReviewsController — `courses/:id/reviews*` (P64 Phase 4, master
 * plan §D.4/§L). Same flat, course-id-scoped shape as
 * `AssignmentsController`/`QuizzesController`.
 *
 * Route declaration order matters (see `AssignmentsController`'s identical
 * note): the literal `reviews/mine` and `reviews/moderation` routes are
 * declared before the parameterized `reviews/:reviewId` routes so Nest's
 * router never treats "mine"/"moderation" as a review id.
 *
 * `getMyReview` bypasses Nest's default response handling via `@Res()` —
 * its real contract is `CourseReviewResponse | null`, and Nest collapses a
 * returned `null` into an empty body rather than the JSON literal `null`
 * the frontend expects (same reason `AssignmentsController.getSubmission`
 * does it).
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
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { CourseReviewsService } from '../services/course-reviews.service';
import {
  CreateCourseReviewDto,
  ListCourseReviewsQueryDto,
  UpdateCourseReviewDto,
} from '../dto/course-review.dto';
import type { CourseReviewResponse } from '../dto/course-review.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('courses')
@UseGuards(JwtAuthGuard)
export class CourseReviewsController {
  constructor(private readonly courseReviewsService: CourseReviewsService) {}

  // ---- Learner (author) ----

  /** The caller's own review for this course, or JSON `null`. */
  @Get(':id/reviews/mine')
  async getMyReview(
    @Req() request: Request,
    @Res() response: Response,
    @Param('id') courseId: string,
  ): Promise<void> {
    const result = await this.courseReviewsService.getMyReview(
      request.authContext!.userId,
      courseId,
    );
    response.status(200).json(result);
  }

  /** Create (or replace) the caller's review; requires active enrollment. */
  @Post(':id/reviews')
  async createMyReview(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Body() dto: CreateCourseReviewDto,
  ): Promise<CourseReviewResponse> {
    return this.courseReviewsService.createMyReview(
      request.authContext!.userId,
      courseId,
      dto,
    );
  }

  /** Edit the caller's own review; resets it to pending. */
  @Patch(':id/reviews/mine')
  async updateMyReview(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Body() dto: UpdateCourseReviewDto,
  ): Promise<CourseReviewResponse> {
    return this.courseReviewsService.updateMyReview(
      request.authContext!.userId,
      courseId,
      dto,
    );
  }

  /** Delete the caller's own review. */
  @Delete(':id/reviews/mine')
  @HttpCode(204)
  async deleteMyReview(
    @Req() request: Request,
    @Param('id') courseId: string,
  ): Promise<void> {
    await this.courseReviewsService.deleteMyReview(request.authContext!.userId, courseId);
  }

  // ---- Reviewer (moderation) ----

  /** Every status of this course's reviews, for the course's reviewer. */
  @Get(':id/reviews/moderation')
  async listForModeration(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Query() query: ListCourseReviewsQueryDto,
  ): Promise<PaginatedResult<CourseReviewResponse>> {
    return this.courseReviewsService.listForModeration(
      request.authContext!.userId,
      courseId,
      { page: query.page, pageSize: query.pageSize, status: query.status },
    );
  }

  @Post(':id/reviews/:reviewId/approve')
  async approve(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('reviewId') reviewId: string,
  ): Promise<CourseReviewResponse> {
    return this.courseReviewsService.approve(
      request.authContext!.userId,
      courseId,
      reviewId,
    );
  }

  @Post(':id/reviews/:reviewId/reject')
  async reject(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('reviewId') reviewId: string,
  ): Promise<CourseReviewResponse> {
    return this.courseReviewsService.reject(
      request.authContext!.userId,
      courseId,
      reviewId,
    );
  }

  /** A reviewer removes a review from their course. */
  @Delete(':id/reviews/:reviewId')
  @HttpCode(204)
  async removeAsReviewer(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Param('reviewId') reviewId: string,
  ): Promise<void> {
    await this.courseReviewsService.removeAsReviewer(
      request.authContext!.userId,
      courseId,
      reviewId,
    );
  }
}
