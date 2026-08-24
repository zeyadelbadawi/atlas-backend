/**
 * CoursesRepository — every method takes a `Prisma.TransactionClient`
 * obtained from `TenancyContextService`, never the raw `PrismaService`,
 * matching `AcademiesRepository`'s established rule.
 */
import { Injectable } from '@nestjs/common';
import type {
  Course,
  CourseCategory,
  CourseInstructor,
  Prisma,
  User,
} from '@prisma/client';

export type CourseWithRelations = Course & {
  category?: CourseCategory | null;
  instructors?: (CourseInstructor & { user: Pick<User, 'id' | 'name' | 'avatarUrl'> })[];
};

export interface CourseListFilter {
  readonly search?: string;
  readonly status?: Course['status'];
  readonly visibility?: Course['visibility'];
  readonly categoryId?: string;
  readonly pricingType?: Course['pricingType'];
  readonly sortBy?: 'title' | 'createdAt' | 'updatedAt' | 'publishedAt';
  readonly sortDirection?: 'asc' | 'desc';
  readonly skip: number;
  readonly take: number;
}

const INSTRUCTOR_INCLUDE = {
  include: { user: { select: { id: true, name: true, avatarUrl: true } } },
} as const;

@Injectable()
export class CoursesRepository {
  findById(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<CourseWithRelations | null> {
    return tx.course.findUnique({
      where: { id },
      include: { category: true, instructors: INSTRUCTOR_INCLUDE },
    });
  }

  /** `courses.slug` is unique only `(academy_id, slug)` — not globally — so this looks up the compound key directly, scoped to the one academy a collision would actually matter for. An unrelated course in a different academy sharing the same slug string is never even queried, let alone mistaken for a collision. */
  findByAcademyAndSlug(
    tx: Prisma.TransactionClient,
    academyId: string,
    slug: string,
  ): Promise<Course | null> {
    return tx.course.findUnique({ where: { academyId_slug: { academyId, slug } } });
  }

  async findManyForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    filter: CourseListFilter,
  ): Promise<{ items: CourseWithRelations[]; totalItems: number }> {
    const where: Prisma.CourseWhereInput = {
      academyId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.visibility ? { visibility: filter.visibility } : {}),
      ...(filter.categoryId ? { categoryId: filter.categoryId } : {}),
      ...(filter.pricingType ? { pricingType: filter.pricingType } : {}),
      ...(filter.search
        ? { title: { contains: filter.search, mode: 'insensitive' as const } }
        : {}),
    };

    const [items, totalItems] = await Promise.all([
      tx.course.findMany({
        where,
        include: { category: true, instructors: INSTRUCTOR_INCLUDE },
        orderBy: { [filter.sortBy ?? 'createdAt']: filter.sortDirection ?? 'desc' },
        skip: filter.skip,
        take: filter.take,
      }),
      tx.course.count({ where }),
    ]);

    return { items, totalItems };
  }

  create(tx: Prisma.TransactionClient, data: Prisma.CourseCreateInput): Promise<Course> {
    return tx.course.create({ data });
  }

  update(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.CourseUpdateInput,
  ): Promise<Course> {
    return tx.course.update({ where: { id }, data });
  }

  countSections(tx: Prisma.TransactionClient, courseId: string): Promise<number> {
    return tx.courseSection.count({ where: { courseId } });
  }

  countLessons(tx: Prisma.TransactionClient, courseId: string): Promise<number> {
    return tx.courseLesson.count({ where: { courseId } });
  }
}
