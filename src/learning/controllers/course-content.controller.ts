/**
 * CourseContentController — `courses/:id/sections` (P29). Same flat,
 * course-id-scoped, guard-less-beyond-`JwtAuthGuard` shape as
 * `QuizzesController`/`CourseProgressController` — see
 * `CourseContentService`'s own doc comment for why this exists alongside
 * the academy-scoped `CourseCurriculumController`.
 */
import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { CourseContentService } from '../services/course-content.service';
import type { CourseSectionResponse } from '../../course/dto/course-section.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('courses')
@UseGuards(JwtAuthGuard)
export class CourseContentController {
  constructor(private readonly courseContentService: CourseContentService) {}

  @Get(':id/sections')
  async getSections(
    @Req() request: Request,
    @Param('id') courseId: string,
  ): Promise<PaginatedResult<CourseSectionResponse>> {
    return this.courseContentService.getSections(request.authContext!.userId, courseId);
  }
}
