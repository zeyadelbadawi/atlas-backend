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
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { CourseCurriculumService } from '../services/course-curriculum.service';
import { UnitCurriculumService } from '../services/unit-curriculum.service';
import {
  CreateCourseSectionDto,
  UpdateCourseSectionDto,
} from '../dto/course-section.dto';
import { CreateCourseLessonDto, UpdateCourseLessonDto } from '../dto/course-lesson.dto';
import { ReorderItemsDto } from '../dto/reorder-items.dto';
import { AttachCurriculumItemDto } from '../dto/attach-curriculum-item.dto';
import type { CourseSectionResponse } from '../dto/course-section.contract';
import type { CourseLessonResponse } from '../dto/course-lesson.contract';
import type {
  AvailableCurriculumItemResponse,
  CurriculumItemResponse,
} from '../dto/curriculum-item.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('academies')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, AcademyScopeGuard)
export class CourseCurriculumController {
  constructor(
    private readonly curriculumService: CourseCurriculumService,
    private readonly unitCurriculumService: UnitCurriculumService,
  ) {}

  @Get(':id/courses/:courseId/sections')
  async getSections(
    @Req() request: Request,
    @Param('courseId') courseId: string,
  ): Promise<PaginatedResult<CourseSectionResponse>> {
    const { academyId, organizationId } = request.academyContext!;
    return this.curriculumService.getSections(
      courseId,
      academyId,
      organizationId,
      request.authContext!.userId,
    );
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
  // ---- Unified unit curriculum (P52) ----------------------------------
  // ONE ordered sequence per unit composed from the existing content types.
  // Static `.../items/*` routes precede any dynamic sibling, matching the
  // ordering rule documented at the top of this controller.

  @Get(':id/courses/:courseId/available-content')
  async getAvailableContent(
    @Req() request: Request,
    @Param('courseId') courseId: string,
  ): Promise<AvailableCurriculumItemResponse[]> {
    const { academyId, organizationId } = request.academyContext!;
    return this.unitCurriculumService.getAvailableContent(
      courseId,
      academyId,
      organizationId,
      request.authContext!.userId,
    );
  }

  @Get(':id/courses/:courseId/sections/:sectionId/items')
  async getUnitItems(
    @Req() request: Request,
    @Param('courseId') courseId: string,
    @Param('sectionId') sectionId: string,
  ): Promise<CurriculumItemResponse[]> {
    const { academyId, organizationId } = request.academyContext!;
    return this.unitCurriculumService.getItems(
      courseId,
      sectionId,
      academyId,
      organizationId,
      request.authContext!.userId,
    );
  }

  @Post(':id/courses/:courseId/sections/:sectionId/items/attach')
  async attachUnitItem(
    @Req() request: Request,
    @Param('courseId') courseId: string,
    @Param('sectionId') sectionId: string,
    @Body() body: AttachCurriculumItemDto,
  ): Promise<CurriculumItemResponse[]> {
    const { academyId, organizationId } = request.academyContext!;
    return this.unitCurriculumService.attachItem(
      courseId,
      sectionId,
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }

  @Post(':id/courses/:courseId/sections/:sectionId/items/detach')
  async detachUnitItem(
    @Req() request: Request,
    @Param('courseId') courseId: string,
    @Param('sectionId') sectionId: string,
    @Body() body: AttachCurriculumItemDto,
  ): Promise<CurriculumItemResponse[]> {
    const { academyId, organizationId } = request.academyContext!;
    return this.unitCurriculumService.detachItem(
      courseId,
      sectionId,
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }

  @Patch(':id/courses/:courseId/sections/:sectionId/items/order')
  @HttpCode(204)
  async reorderUnitItems(
    @Req() request: Request,
    @Param('courseId') courseId: string,
    @Param('sectionId') sectionId: string,
    @Body() body: ReorderItemsDto,
  ): Promise<void> {
    const { academyId, organizationId } = request.academyContext!;
    return this.unitCurriculumService.reorderItems(
      courseId,
      sectionId,
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }
}
