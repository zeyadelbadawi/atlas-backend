/**
 * PlatformCoursesService — `GET /platform-courses` and
 * `GET /platform-courses/:id` (P60), the Platform Owner's cross-tenant view
 * of every course on the platform.
 *
 * READ-ONLY, ON PURPOSE. There is no create/update/delete here and no plan
 * to add one. Course authoring belongs to the academy that owns the course;
 * the platform surface exists for oversight, and giving it write access
 * would mean a second, differently-authorised way to mutate tenant content.
 * The `_platform_select`-only RLS policies (P15, P60b) enforce the same
 * boundary independently of this class.
 *
 * Every read runs inside `TenancyContextService.runInUserContext(
 * platformOwnerId)` — no `app.current_organization_id` — so the only RLS
 * policy that can match is the platform one, and a caller who somehow
 * reached this code without being a platform owner sees an empty result
 * rather than another tenant's data. Guard decides, RLS independently
 * agrees.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { CoursesRepository } from '../../course/repositories/courses.repository';
import {
  toPlatformCourseDetailResponse,
  toPlatformCourseSummaryResponse,
} from '../dto/platform-course.contract';
import type {
  PlatformCourseDetailResponse,
  PlatformCourseSummaryResponse,
} from '../dto/platform-course.contract';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { ListPlatformCoursesQueryDto } from '../dto/list-platform-courses-query.dto';

@Injectable()
export class PlatformCoursesService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly coursesRepository: CoursesRepository,
  ) {}

  async listCourses(
    platformOwnerId: string,
    query: ListPlatformCoursesQueryDto,
  ): Promise<PaginatedResult<PlatformCourseSummaryResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      (tx) =>
        this.coursesRepository.findManyAnyAcademy(tx, {
          search: query.search,
          status: query.status,
          visibility: query.visibility,
          pricingType: query.pricingType,
          academyId: query.academyId,
          organizationId: query.organizationId,
          sortBy: query.sortBy,
          sortDirection: query.sortDirection,
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );

    return {
      // Enrolment counts come from the page's own filtered `_count`, one
      // aggregate per row inside the single list query — never a follow-up
      // query per course, which is the N+1 the platform academies list was
      // explicitly written to avoid.
      items: items.map((course) => toPlatformCourseSummaryResponse(course)),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  async getCourse(
    platformOwnerId: string,
    courseId: string,
  ): Promise<PlatformCourseDetailResponse> {
    const course = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      (tx) => this.coursesRepository.findByIdAnyAcademy(tx, courseId),
    );
    if (!course) {
      // Also the answer when the row exists but RLS hid it, which is the
      // correct response either way: a caller who cannot see a course must
      // not be able to tell "no such course" from "not yours".
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }

    const [totalSections, totalLessons, enrollmentsByStatus, paidOrders] =
      await Promise.all([
        this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
          this.coursesRepository.countSections(tx, courseId),
        ),
        this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
          this.coursesRepository.countLessons(tx, courseId),
        ),
        this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
          this.coursesRepository.countEnrollmentsByStatus(tx, courseId),
        ),
        this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
          this.coursesRepository.countPaidOrders(tx, courseId),
        ),
      ]);

    return toPlatformCourseDetailResponse(course, {
      totalSections,
      totalLessons,
      completedStudents: enrollmentsByStatus.completed ?? 0,
      paidOrders,
    });
  }
}
