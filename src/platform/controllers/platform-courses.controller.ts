/**
 * PlatformCoursesController — `platform-courses` (P60).
 *
 * A distinct resource name from the tenant-scoped `courses` path that
 * `CoursesController` (P5) owns, matching the `platform-academies` /
 * `platform-users` convention already established here. GET only: the
 * platform course surface is read-only, and the absence of any write route
 * is the first of the two independent barriers (the second being RLS, which
 * grants the platform owner SELECT and nothing else).
 */
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { PlatformCoursesService } from '../services/platform-courses.service';
import { ListPlatformCoursesQueryDto } from '../dto/list-platform-courses-query.dto';
import type {
  PlatformCourseDetailResponse,
  PlatformCourseSummaryResponse,
} from '../dto/platform-course.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('platform-courses')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, PlatformOwnerGuard)
export class PlatformCoursesController {
  constructor(private readonly platformCoursesService: PlatformCoursesService) {}

  @Get()
  async list(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: ListPlatformCoursesQueryDto,
  ): Promise<PaginatedResult<PlatformCourseSummaryResponse>> {
    return this.platformCoursesService.listCourses(auth.userId, query);
  }

  @Get(':id')
  async getById(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<PlatformCourseDetailResponse> {
    return this.platformCoursesService.getCourse(auth.userId, id);
  }
}
