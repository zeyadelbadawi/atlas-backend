/**
 * CourseCurriculumController — `academies/:id/courses/:courseId/sections/*`
 * (master plan §10, P5). Same guard reuse as `CoursesController`.
 *
 * Route declaration order matters: the static `sections/order` and
 * `sections/:sectionId/lessons/order` routes are declared BEFORE their
 * dynamic `:sectionId`/`:lessonId` siblings — Express/Nest matches routes
 * in declaration order for equally-specific paths, so `order` would
 * otherwise be greedily captured as a `:sectionId`/`:lessonId` value by
 * the dynamic route registered first.
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
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { CourseCurriculumService } from '../services/course-curriculum.service';
import {
  CreateCourseSectionDto,
  UpdateCourseSectionDto,
} from '../dto/course-section.dto';
import { CreateCourseLessonDto, UpdateCourseLessonDto } from '../dto/course-lesson.dto';
import { ReorderItemsDto } from '../dto/reorder-items.dto';
import type { CourseSectionResponse } from '../dto/course-section.contract';
import type { CourseLessonResponse } from '../dto/course-lesson.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('academies')
@UseGuards(JwtAuthGuard, AcademyScopeGuard)
export class CourseCurriculumController {
  constructor(private readonly curriculumService: CourseCurriculumService) {}

  @Get(':id/courses/:courseId/sections')
  async getSections(
    @Req() request: Request,
    @Param('courseId') courseId: string,
  ): Promise<PaginatedResult<CourseSectionResponse>> {
    const { academyId, organizationId } = request.academyContext!;
    return this.curriculumService.getSections(courseId, academyId, organizationId);
  }

  @Post(':id/courses/:courseId/sections')
  async createSection(
    @Req() request: Request,
    @Param('courseId') courseId: string,
    @Body() body: CreateCourseSectionDto,
  ): Promise<CourseSectionResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.curriculumService.createSection(
      courseId,
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }

  // Static route — must precede `:sectionId` below.
  @Patch(':id/courses/:courseId/sections/order')
  @HttpCode(204)
  async reorderSections(
    @Req() request: Request,
    @Param('courseId') courseId: string,
    @Body() body: ReorderItemsDto,
  ): Promise<void> {
    const { academyId, organizationId } = request.academyContext!;
    return this.curriculumService.reorderSections(
      courseId,
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }

  @Patch(':id/courses/:courseId/sections/:sectionId')
  async updateSection(
    @Req() request: Request,
    @Param('courseId') courseId: string,
    @Param('sectionId') sectionId: string,
    @Body() body: UpdateCourseSectionDto,
  ): Promise<CourseSectionResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.curriculumService.updateSection(
      sectionId,
      courseId,
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }

  @Delete(':id/courses/:courseId/sections/:sectionId')
  @HttpCode(204)
  async deleteSection(
    @Req() request: Request,
    @Param('courseId') courseId: string,
    @Param('sectionId') sectionId: string,
  ): Promise<void> {
    const { academyId, organizationId } = request.academyContext!;
    return this.curriculumService.deleteSection(
      sectionId,
      courseId,
      academyId,
      organizationId,
      request.authContext!.userId,
    );
  }

  @Post(':id/courses/:courseId/sections/:sectionId/lessons')
  async createLesson(
    @Req() request: Request,
    @Param('courseId') courseId: string,
    @Param('sectionId') sectionId: string,
    @Body() body: CreateCourseLessonDto,
  ): Promise<CourseLessonResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.curriculumService.createLesson(
      sectionId,
      courseId,
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }

  // Static route — must precede `:lessonId` below.
  @Patch(':id/courses/:courseId/sections/:sectionId/lessons/order')
  @HttpCode(204)
  async reorderLessons(
    @Req() request: Request,
    @Param('courseId') courseId: string,
    @Param('sectionId') sectionId: string,
    @Body() body: ReorderItemsDto,
  ): Promise<void> {
    const { academyId, organizationId } = request.academyContext!;
    return this.curriculumService.reorderLessons(
      sectionId,
      courseId,
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }

  @Patch(':id/courses/:courseId/sections/:sectionId/lessons/:lessonId')
  async updateLesson(
    @Req() request: Request,
    @Param('courseId') courseId: string,
    @Param('sectionId') sectionId: string,
    @Param('lessonId') lessonId: string,
    @Body() body: UpdateCourseLessonDto,
  ): Promise<CourseLessonResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.curriculumService.updateLesson(
      lessonId,
      sectionId,
      courseId,
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }

  @Delete(':id/courses/:courseId/sections/:sectionId/lessons/:lessonId')
  @HttpCode(204)
  async deleteLesson(
    @Req() request: Request,
    @Param('courseId') courseId: string,
    @Param('sectionId') sectionId: string,
    @Param('lessonId') lessonId: string,
  ): Promise<void> {
    const { academyId, organizationId } = request.academyContext!;
    return this.curriculumService.deleteLesson(
      lessonId,
      sectionId,
      courseId,
      academyId,
      organizationId,
      request.authContext!.userId,
    );
  }
}
