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
  EnrollmentStatus,
  Prisma,
  User,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export type CourseWithRelations = Course & {
  category?: CourseCategory | null;
  instructors?: (CourseInstructor & { user: Pick<User, 'id' | 'name' | 'avatarUrl'> })[];
};

/**
 * P60 — one row of the Platform Owner's cross-tenant course list.
 *
 * Carries the academy AND its organization because the whole point of the
 * global list is that two courses in it may belong to different tenants;
 * a row with only `academyId` would force the reader to look up which
 * customer it belongs to. `createdBy` is nullable all the way through —
 * see the `Course.createdBy` doc comment: unknown is a real, honest value
 * here, not a loading state.
 */
export type PlatformCourseRow = Course & {
  academy: {
    id: string;
    name: string;
    organizationId: string;
    organization: { id: string; name: string };
  };
  category: CourseCategory | null;
  createdBy: Pick<User, 'id' | 'name' | 'email'> | null;
  _count: { enrollments: number };
};

export type PlatformCourseDetailRow = PlatformCourseRow & {
  instructors: (CourseInstructor & { user: Pick<User, 'id' | 'name' | 'avatarUrl'> })[];
};

export interface PlatformCourseListFilter {
  readonly search?: string;
  readonly status?: Course['status'];
  readonly visibility?: Course['visibility'];
  readonly pricingType?: Course['pricingType'];
  readonly academyId?: string;
  readonly organizationId?: string;
  readonly sortBy?: 'title' | 'createdAt' | 'updatedAt' | 'publishedAt';
  readonly sortDirection?: 'asc' | 'desc';
  readonly skip: number;
  readonly take: number;
}

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
  /** `findManyPublished` only — scopes the cross-academy discovery catalog down to one academy (public website's own Featured Courses/Instructors sections; see that method's doc comment). */
  readonly academyId?: string;
}

const INSTRUCTOR_INCLUDE = {
  include: { user: { select: { id: true, name: true, avatarUrl: true } } },
} as const;

/**
 * P60 — the `EnrollmentStatus` values that mean a real student is taking
 * (or has taken) the course. `available`/`pending`/`unavailable` are
 * eligibility states, not participation.
 */
const ENROLLED_STATUSES: EnrollmentStatus[] = ['enrolled', 'completed'];

/**
 * P60 — what every platform-side course read pulls alongside the row.
 * Defined once so the list and the detail can never drift into showing
 * different owning-academy or creator information for the same course.
 */
const PLATFORM_COURSE_INCLUDE = {
  academy: {
    select: {
      id: true,
      name: true,
      organizationId: true,
      organization: { select: { id: true, name: true } },
    },
  },
  category: true,
  // Only the three fields the console renders. Never the whole `User` —
  // that row carries the password hash and every auth field with it.
  createdBy: { select: { id: true, name: true, email: true } },
  // FILTERED deliberately. `EnrollmentStatus` also carries `available`,
  // `pending` and `unavailable` — catalogue//eligibility states, not people
  // taking the course. An unfiltered count would put a number under
  // "Enrolled students" that no academy owner would recognise.
  _count: {
    select: { enrollments: { where: { status: { in: ENROLLED_STATUSES } } } },
  },
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

  /**
   * P60 — the Platform Owner's cross-tenant course list.
   *
   * NO `academyId` in the base `where`, which is the entire difference from
   * `findManyForAcademy` above. Cross-tenant visibility comes from
   * `courses_platform_select` (P15) and nothing else: call this ONLY inside
   * `TenancyContextService.runInUserContext(platformOwnerId)`, where no
   * `app.current_organization_id` is set, so the tenant policy cannot match
   * and a non-owner sees zero rows even if they somehow reached this code.
   * The guard on the controller and this policy have to agree independently.
   *
   * `search` spans title, slug, academy name and organization name, because
   * an operator looking at a global list is as likely to be searching for
   * "which courses does Acme have" as for a course by name.
   */
  async findManyAnyAcademy(
    tx: Prisma.TransactionClient,
    filter: PlatformCourseListFilter,
  ): Promise<{ items: PlatformCourseRow[]; totalItems: number }> {
    const search = filter.search?.trim();
    const where: Prisma.CourseWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.visibility ? { visibility: filter.visibility } : {}),
      ...(filter.pricingType ? { pricingType: filter.pricingType } : {}),
      ...(filter.academyId ? { academyId: filter.academyId } : {}),
      ...(filter.organizationId
        ? { academy: { organizationId: filter.organizationId } }
        : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' as const } },
              { slug: { contains: search, mode: 'insensitive' as const } },
              {
                academy: {
                  is: { name: { contains: search, mode: 'insensitive' as const } },
                },
              },
              {
                academy: {
                  is: {
                    organization: {
                      is: { name: { contains: search, mode: 'insensitive' as const } },
                    },
                  },
                },
              },
            ],
          }
        : {}),
    };

    const [items, totalItems] = await Promise.all([
      tx.course.findMany({
        where,
        include: PLATFORM_COURSE_INCLUDE,
        orderBy: { [filter.sortBy ?? 'createdAt']: filter.sortDirection ?? 'desc' },
        skip: filter.skip,
        take: filter.take,
      }),
      tx.course.count({ where }),
    ]);

    return { items, totalItems };
  }

  /** P60 — one course, from any tenant. Same RLS contract as `findManyAnyAcademy`. */
  findByIdAnyAcademy(
    tx: Prisma.TransactionClient,
    courseId: string,
  ): Promise<PlatformCourseDetailRow | null> {
    return tx.course.findUnique({
      where: { id: courseId },
      include: { ...PLATFORM_COURSE_INCLUDE, instructors: INSTRUCTOR_INCLUDE },
    }) as Promise<PlatformCourseDetailRow | null>;
  }

  /**
   * P60 — enrollment outcomes for one course, as ONE grouped query.
   *
   * Returns the raw per-status counts rather than a pre-baked
   * "enrolled/completed" pair so the caller decides what to name them —
   * `EnrollmentStatus` is the existing vocabulary and this deliberately
   * does not invent a second one on top of it.
   */
  async countEnrollmentsByStatus(
    tx: Prisma.TransactionClient,
    courseId: string,
  ): Promise<Record<string, number>> {
    const rows = await tx.enrollment.groupBy({
      by: ['status'],
      where: { courseId },
      _count: { _all: true },
    });
    return Object.fromEntries(rows.map((row) => [row.status, row._count._all]));
  }

  /**
   * P60 — paid access for one course, counted from `course_orders` (P13),
   * the system that already owns "who paid for this course". Only `paid`
   * orders count; a pending or failed checkout is not access.
   */
  countPaidOrders(tx: Prisma.TransactionClient, courseId: string): Promise<number> {
    return tx.courseOrder.count({ where: { courseId, status: 'paid' } });
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

  /**
   * Phase 6 — the public statistics endpoint's real, live published-course
   * count. Hardcodes `status: 'published', visibility: 'public'` for the
   * exact same reason `findManyPublished` does (see that method's own doc
   * comment): this is the established, reused definition of "publicly
   * countable course" (`FeaturedCoursesSection`/`InstructorsSection`, atlas
   * frontend, already filter identically) — never a caller-suppliable
   * status/visibility that could widen the count to include drafts.
   */
  countPublished(tx: Prisma.TransactionClient, academyId: string): Promise<number> {
    return tx.course.count({
      where: { academyId, status: 'published', visibility: 'public' },
    });
  }

  countSections(tx: Prisma.TransactionClient, courseId: string): Promise<number> {
    return tx.courseSection.count({ where: { courseId } });
  }

  countLessons(tx: Prisma.TransactionClient, courseId: string): Promise<number> {
    return tx.courseLesson.count({ where: { courseId } });
  }

  /**
   * Batched counterpart to `countSections`/`countLessons` for a whole page
   * of courses at once — two `groupBy` round trips total, not `2 × pageSize`.
   * Added after the cross-academy discovery catalog (`findManyPublished`,
   * called with no `academyId` filter) grew large enough that the previous
   * per-course `Promise.all` loop (`CourseDiscoveryService.discoverCourses`,
   * `CoursesService.list`) exceeded Prisma's interactive-transaction timeout
   * mid-page and threw. Missing entries mean zero, not absent — callers
   * should read via `?? 0`.
   */
  async countSectionsAndLessonsBatch(
    tx: Prisma.TransactionClient,
    courseIds: readonly string[],
  ): Promise<{ sectionCounts: Map<string, number>; lessonCounts: Map<string, number> }> {
    if (courseIds.length === 0) {
      return { sectionCounts: new Map(), lessonCounts: new Map() };
    }

    const [sectionGroups, lessonGroups] = await Promise.all([
      tx.courseSection.groupBy({
        by: ['courseId'],
        where: { courseId: { in: courseIds as string[] } },
        _count: { _all: true },
      }),
      tx.courseLesson.groupBy({
        by: ['courseId'],
        where: { courseId: { in: courseIds as string[] } },
        _count: { _all: true },
      }),
    ]);

    return {
      sectionCounts: new Map(
        sectionGroups.map((group) => [group.courseId, group._count._all]),
      ),
      lessonCounts: new Map(
        lessonGroups.map((group) => [group.courseId, group._count._all]),
      ),
    };
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
      ...(filter.academyId ? { academyId: filter.academyId } : {}),
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
