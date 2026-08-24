/**
 * EnrollmentsController — `enrollments` (flat, master plan §10). Always
 * the current authenticated student's own — `studentId` is resolved from
 * `request.authContext.userId`, never accepted as a route/body parameter.
 *
 * `GET .../by-course/:courseId` is declared as a static-then-dynamic
 * two-segment path, not `GET :courseId`, matching `CourseCurriculumController`'s
 * exact "static route before a bare dynamic one" precedent from P5.
 *
 * `getForCourse` bypasses Nest's default response handling via `@Res()` —
 * `EnrollmentService.getEnrollmentForCourse`'s real contract is
 * `Enrollment | null`, but Nest's router treats a returned `null` exactly
 * like `undefined` (`isNil` in `@nestjs/platform-express`'s `reply()`) and
 * sends an empty body instead of the JSON literal `null` the frontend
 * type expects — confirmed empirically, not assumed. Manually calling
 * `response.json(result)` sends the real `null` when there's no
 * enrollment, exactly matching the frontend's `Enrollment | null` type.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { EnrollmentsService } from '../services/enrollments.service';
import { CreateEnrollmentDto } from '../dto/create-enrollment.dto';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type { EnrollmentResponse } from '../dto/enrollment.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('enrollments')
@UseGuards(JwtAuthGuard)
export class EnrollmentsController {
  constructor(private readonly enrollmentsService: EnrollmentsService) {}

  @Get()
  async list(
    @Req() request: Request,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<EnrollmentResponse>> {
    return this.enrollmentsService.list(request.authContext!.userId, query);
  }

  @Get('by-course/:courseId')
  async getForCourse(
    @Req() request: Request,
    @Res() response: Response,
    @Param('courseId') courseId: string,
  ): Promise<void> {
    const result = await this.enrollmentsService.getForCourse(
      request.authContext!.userId,
      courseId,
    );
    response.status(200).json(result);
  }

  @Post()
  async create(
    @Req() request: Request,
    @Body() body: CreateEnrollmentDto,
  ): Promise<EnrollmentResponse> {
    return this.enrollmentsService.createEnrollment(request.authContext!.userId, body);
  }
}
