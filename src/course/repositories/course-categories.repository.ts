/** CourseCategoriesRepository — read-only in P5 (see `schema.prisma`'s doc comment on `CourseCategory`: no `CourseService` method creates/updates/deletes a category). Seed/fixture data is written via the admin superuser connection, never through this repository. */
import { Injectable } from '@nestjs/common';
import type { CourseCategory, Prisma } from '@prisma/client';

@Injectable()
export class CourseCategoriesRepository {
  findById(tx: Prisma.TransactionClient, id: string): Promise<CourseCategory | null> {
    return tx.courseCategory.findUnique({ where: { id } });
  }

  findManyForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<CourseCategory[]> {
    return tx.courseCategory.findMany({ where: { academyId }, orderBy: { name: 'asc' } });
  }

  /**
   * Theme 1 plan Phase 2 — how many PUBLISHED, PUBLIC courses each of this
   * Academy's categories holds (the same filter as the public catalog,
   * `CoursesRepository.findManyPublished`). Drafts and private courses are
   * never counted, so the public site can't reveal them.
   */
  countPublishedPublicCoursesByCategory(tx: Prisma.TransactionClient, academyId: string) {
    return tx.course.groupBy({
      by: ['categoryId'],
      where: {
        academyId,
        status: 'published',
        visibility: 'public',
        categoryId: { not: null },
      },
      _count: { categoryId: true },
    });
  }

  countCoursesByCategory(tx: Prisma.TransactionClient, categoryIds: readonly string[]) {
    return tx.course.groupBy({
      by: ['categoryId'],
      where: { categoryId: { in: [...categoryIds] } },
      _count: { categoryId: true },
    });
  }
}
