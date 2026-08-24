/**
 * CourseDiscoveryController — `courses` (flat, master plan §10 "Course
 * discovery" row, P6). `JwtAuthGuard` alone — no academy/organization
 * resolution here at all; every result is scoped by the row's own
 * `status`/`visibility`, not by the caller's tenant membership (see
 * `CourseDiscoveryService`'s doc comment).
 */
import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { CourseDiscoveryService } from '../services/course-discovery.service';
import { CourseListQueryDto } from '../../course/dto/course-list-query.dto';
import type { CourseResponse } from '../../course/dto/course.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('courses')
@UseGuards(JwtAuthGuard)
export class CourseDiscoveryController {
  constructor(private readonly courseDiscoveryService: CourseDiscoveryService) {}

  @Get()
  async discoverCourses(
    @Req() request: Request,
    @Query() query: CourseListQueryDto,
  ): Promise<PaginatedResult<CourseResponse>> {
    return this.courseDiscoveryService.discoverCourses(
      request.authContext!.userId,
      query,
    );
  }

  @Get(':id')
  async discoverCourse(
    @Req() request: Request,
    @Param('id') courseId: string,
  ): Promise<CourseResponse> {
    return this.courseDiscoveryService.discoverCourse(
      request.authContext!.userId,
      courseId,
    );
  }
}
