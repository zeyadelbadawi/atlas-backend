/**
 * CoursesController — `academies/:id/courses/*` and
 * `academies/:id/course-categories/*` (master plan §10, P5). Every route
 * reuses `AcademyScopeGuard` verbatim, unmodified — the same guard
 * `AcademiesController` itself uses — since `:id` here is always the
 * ACADEMY id (never a course id), exactly matching how
 * `academies/:id/members` etc. already work. See `AcademyScopeGuard`'s own
 * doc comment for the transitive-tenancy-resolution mechanism this reuses.
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
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { CoursesService } from '../services/courses.service';
import { CreateCourseDto } from '../dto/create-course.dto';
import { UpdateCourseDto } from '../dto/update-course.dto';
import { AssignCourseInstructorDto } from '../dto/assign-course-instructor.dto';
import { CourseListQueryDto } from '../dto/course-list-query.dto';
import type { CourseResponse } from '../dto/course.contract';
import type { CourseCategoryResponse } from '../dto/course-category.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('academies')
@UseGuards(JwtAuthGuard, AcademyScopeGuard)
export class CoursesController {
  constructor(private readonly coursesService: CoursesService) {}

  @Get(':id/courses')
  async list(
    @Req() request: Request,
    @Query() query: CourseListQueryDto,
  ): Promise<PaginatedResult<CourseResponse>> {
    const { academyId, organizationId } = request.academyContext!;
    return this.coursesService.list(academyId, organizationId, query);
  }

  @Post(':id/courses')
  async create(
    @Req() request: Request,
    @Body() body: CreateCourseDto,
  ): Promise<CourseResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.coursesService.create(
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }

  @Get(':id/courses/:courseId')
  async getById(
    @Req() request: Request,
    @Param('courseId') courseId: string,
  ): Promise<CourseResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.coursesService.getById(courseId, academyId, organizationId);
  }

  @Patch(':id/courses/:courseId')
  async update(
    @Req() request: Request,
    @Param('courseId') courseId: string,
    @Body() body: UpdateCourseDto,
  ): Promise<CourseResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.coursesService.update(
      courseId,
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }

  @Delete(':id/courses/:courseId')
  @HttpCode(204)
  async archive(
    @Req() request: Request,
    @Param('courseId') courseId: string,
  ): Promise<void> {
    const { academyId, organizationId } = request.academyContext!;
    return this.coursesService.archive(
      courseId,
      academyId,
      organizationId,
      request.authContext!.userId,
    );
  }

  @Post(':id/courses/:courseId/publish')
  @HttpCode(200)
  async publish(
    @Req() request: Request,
    @Param('courseId') courseId: string,
  ): Promise<CourseResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.coursesService.publish(
      courseId,
      academyId,
      organizationId,
      request.authContext!.userId,
    );
  }

  @Post(':id/courses/:courseId/unpublish')
  @HttpCode(200)
  async unpublish(
    @Req() request: Request,
    @Param('courseId') courseId: string,
  ): Promise<CourseResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.coursesService.unpublish(
      courseId,
      academyId,
      organizationId,
      request.authContext!.userId,
    );
  }

  /**
   * Phase 3 — grants course-level instructor access. `userId` must already
   * be an active `instructor`-role member of THIS academy (see
   * `CoursesService.assignInstructor`'s doc comment) — this never creates
   * an account or an Academy membership, unlike
   * `AcademiesController.addInstructor`.
   */
  @Post(':id/courses/:courseId/instructors')
  async assignInstructor(
    @Req() request: Request,
    @Param('courseId') courseId: string,
    @Body() body: AssignCourseInstructorDto,
  ): Promise<CourseResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.coursesService.assignInstructor(
      courseId,
      academyId,
      organizationId,
      request.authContext!.userId,
      body.userId,
    );
  }

  /** Phase 3 — revokes course-level instructor access. Never removes the target's Academy instructor-roster membership. */
  @Delete(':id/courses/:courseId/instructors/:userId')
  @HttpCode(204)
  async removeInstructor(
    @Req() request: Request,
    @Param('courseId') courseId: string,
    @Param('userId') targetUserId: string,
  ): Promise<void> {
    const { academyId, organizationId } = request.academyContext!;
    return this.coursesService.removeInstructor(
      courseId,
      academyId,
      organizationId,
      request.authContext!.userId,
      targetUserId,
    );
  }

  @Get(':id/course-categories')
  async getCategories(
    @Req() request: Request,
  ): Promise<PaginatedResult<CourseCategoryResponse>> {
    const { academyId, organizationId } = request.academyContext!;
    return this.coursesService.getCategories(academyId, organizationId);
  }

  @Get(':id/course-categories/:categoryId')
  async getCategoryById(
    @Req() request: Request,
    @Param('categoryId') categoryId: string,
  ): Promise<CourseCategoryResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.coursesService.getCategoryById(categoryId, academyId, organizationId);
  }
}
