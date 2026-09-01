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
import { PrismaService } from '../../database/prisma.service';

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
  // Every OTHER method here takes a `Prisma.TransactionClient` — see this
  // class's own header comment. `PrismaService` is injected ONLY for
  // `resolveAcademyIdForPublishedCourse` below, mirroring
  // `AcademiesRepository.resolveOrganizationId`'s identical, documented
  // exception to that rule.
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Phase 2 — `EnrollmentsService.createEnrollment` needs the course's
   * `academyId` (and, from that, its `organizationId`) BEFORE it can open
   * the real `runInTenantAndUserContext` its new live entitlement check
   * requires (that check reads `tenant_subscriptions`/counts other
   * organization-scoped tables, none of which are visible under a bare
   * `runInUserContext`). Safe to call with NO tenant/user context at all
   * — `courses_public_discovery_select`'s RLS policy (P6) has no
   * `current_setting` predicate whatsoever, so a published+public course
   * is visible unconditionally, exactly like `resolve_academy_organization`
   * (P11) and `AcademyStudentsRepository.resolveOrganizationId` (P13) are
   * for the identical "no context yet, but the caller legitimately needs
   * this one fact" problem shape.
   */
  async resolveAcademyIdForPublishedCourse(courseId: string): Promise<string | null> {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, status: 'published', visibility: 'public' },
      select: { academyId: true },
    });
    return course?.academyId ?? null;
  }

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

  /**
   * `discoverCourses` (P6, Student Learning) — the flat, cross-academy,
   * published-only catalog. Deliberately hardcodes `status: 'published'`/
   * `visibility: 'public'` in the `where` clause rather than accepting them
   * as caller-supplied filter values (even though `CourseListFilter`
   * declares both) — a discovery caller must never be able to widen this
   * to see a draft/private course cross-academy by passing a crafted query
   * param. Relies on the additive, context-independent
   * `courses_public_discovery_select` RLS policy (P6 migration) to be
   * readable at all without an `app.current_organization_id` context — a
   * student is never an organization member of the academy that owns the
   * course.
   */
  async findManyPublished(
    tx: Prisma.TransactionClient,
    filter: Omit<CourseListFilter, 'status' | 'visibility'>,
  ): Promise<{ items: CourseWithRelations[]; totalItems: number }> {
    const where: Prisma.CourseWhereInput = {
      status: 'published',
      visibility: 'public',
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

  /** `discoverCourse` (P6) — single published+public course by id, regardless of academy. Same RLS reliance as `findManyPublished`. */
  findPublishedById(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<CourseWithRelations | null> {
    return tx.course.findFirst({
      where: { id, status: 'published', visibility: 'public' },
      include: { category: true, instructors: INSTRUCTOR_INCLUDE },
    });
  }

  /** Phase P15 — `PlatformAcademyDetail.courses` (id/title/status refs only) and `courseCount`. Meaningful only inside `runInUserContext(platformOwnerId)` (the `courses_platform_select` policy); capped, not paginated, matching `AcademiesRepository.findRefsForOrganization`'s identical precedent. */
  findRefsForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    take: number,
  ): Promise<Pick<Course, 'id' | 'title' | 'status'>[]> {
    return tx.course.findMany({
      where: { academyId },
      select: { id: true, title: true, status: true },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }
}
