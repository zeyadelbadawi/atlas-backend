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

  countCoursesByCategory(tx: Prisma.TransactionClient, categoryIds: readonly string[]) {
    return tx.course.groupBy({
      by: ['categoryId'],
      where: { categoryId: { in: [...categoryIds] } },
      _count: { categoryId: true },
    });
  }
}
