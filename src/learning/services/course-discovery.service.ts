/**
 * CourseDiscoveryService — `discoverCourses`/`discoverCourse` (P6, matches
 * `CourseService.discoverCourses`/`.discoverCourse`, atlas frontend). The
 * flat, cross-academy, published-only course catalog — deferred out of P5
 * by that phase's own schema/report, picked up here on schedule (see
 * `learning.module.ts`'s doc comment).
 *
 * Reuses `CoursesRepository` (P5, `CourseModule`, exported for exactly
 * this reuse) rather than duplicating course-table query logic — the two
 * new methods it exposes (`findManyPublished`/`findPublishedById`) live
 * there because they operate on the same `courses` table P5 already owns.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { CoursesRepository } from '../../course/repositories/courses.repository';
import { toCourseResponse } from '../../course/dto/course.contract';
import type { CourseResponse } from '../../course/dto/course.contract';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { CourseListQueryDto } from '../../course/dto/course-list-query.dto';

@Injectable()
export class CourseDiscoveryService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly coursesRepository: CoursesRepository,
  ) {}

  async discoverCourses(
    userId: string,
    query: CourseListQueryDto,
  ): Promise<PaginatedResult<CourseResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    // `query.status`/`.visibility` are deliberately never read here — see
    // `CoursesRepository.findManyPublished`'s own doc comment for why.
    const { items, totalItems } = await this.tenancyContextService.runInUserContext(
      userId,
      (tx) =>
        this.coursesRepository.findManyPublished(tx, {
          search: query.search,
          categoryId: query.categoryId,
          pricingType: query.pricingType,
          sortBy: query.sortBy as
            'title' | 'createdAt' | 'updatedAt' | 'publishedAt' | undefined,
          sortDirection: query.sortDirection,
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );

    const withStats = await this.tenancyContextService.runInUserContext(userId, (tx) =>
      Promise.all(
        items.map(async (course) => {
          const [totalSections, totalLessons] = await Promise.all([
            this.coursesRepository.countSections(tx, course.id),
            this.coursesRepository.countLessons(tx, course.id),
          ]);
          return toCourseResponse(course, { totalSections, totalLessons });
        }),
      ),
    );

    return {
      items: withStats,
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  async discoverCourse(userId: string, courseId: string): Promise<CourseResponse> {
    const { course, totalSections, totalLessons } =
      await this.tenancyContextService.runInUserContext(userId, async (tx) => {
        const row = await this.coursesRepository.findPublishedById(tx, courseId);
        if (!row) throw new NotFoundException({ messageKey: 'errors.notFound' });
        const [sections, lessons] = await Promise.all([
          this.coursesRepository.countSections(tx, courseId),
          this.coursesRepository.countLessons(tx, courseId),
        ]);
        return { course: row, totalSections: sections, totalLessons: lessons };
      });

    return toCourseResponse(course, { totalSections, totalLessons });
  }
}
