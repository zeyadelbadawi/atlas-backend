/**
 * StudentResultsController — `GET /learning/results` (Phase 9, "My
 * Results").
 *
 * `JwtAuthGuard` only. That is the correct and complete guard here for
 * the same reason every other student-facing learning endpoint uses it:
 * this surface is scoped to the CALLER, not to a tenant path parameter.
 * The student id is taken from the authenticated session and never from
 * the request, so there is no id for a caller to substitute — and the
 * underlying tables are additionally restricted to the acting student by
 * their own `*_self_select` RLS policies.
 *
 * The optional `academyId` query parameter narrows the response to one
 * Academy. It cannot be used to widen access: it only ever filters the
 * caller's OWN enrollments, so an unrecognised or foreign id yields an
 * empty result rather than another Academy's data.
 */
import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { StudentResultsService } from '../services/student-results.service';
import { StudentResultsQueryDto } from '../dto/student-results-query.dto';
import type { StudentResultsResponse } from '../dto/student-results.contract';

@Controller('learning')
@UseGuards(JwtAuthGuard)
export class StudentResultsController {
  constructor(private readonly studentResultsService: StudentResultsService) {}

  @Get('results')
  async getMyResults(
    @Req() request: Request,
    @Query() query: StudentResultsQueryDto,
  ): Promise<StudentResultsResponse> {
    return this.studentResultsService.getMyResults(
      request.authContext!.userId,
      query.academyId,
    );
  }
}
