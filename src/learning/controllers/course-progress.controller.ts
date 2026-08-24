/**
 * CourseProgressController — `courses/:id/progress*` (master plan §10,
 * P6). `:id` here is always the COURSE id, never an academy id — a
 * student reaches a course by id alone, learned from their own
 * enrollment (matches `ProgressService`'s own doc comment).
 */
import { Body, Controller, Param, Post, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { CourseProgressService } from '../services/course-progress.service';
import { CompleteLessonDto } from '../dto/complete-lesson.dto';
import type { CourseProgressResponse } from '../dto/course-progress.contract';

@Controller('courses')
@UseGuards(JwtAuthGuard)
export class CourseProgressController {
  constructor(private readonly courseProgressService: CourseProgressService) {}

  @Get(':id/progress')
  async getProgress(
    @Req() request: Request,
    @Param('id') courseId: string,
  ): Promise<CourseProgressResponse> {
    return this.courseProgressService.getCourseProgress(
      request.authContext!.userId,
      courseId,
    );
  }

  @Post(':id/progress/complete-lesson')
  async completeLesson(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Body() body: CompleteLessonDto,
  ): Promise<CourseProgressResponse> {
    return this.courseProgressService.completeLesson(
      request.authContext!.userId,
      courseId,
      body,
    );
  }
}
