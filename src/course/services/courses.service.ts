/**
 * CoursesService — course CRUD, publish/unpublish, and category reads.
 * Mirrors `CourseService`'s authoring surface (atlas frontend).
 *
 * Every method independently re-establishes the RLS tenant context via
 * `TenancyContextService.runInTenantContext`, matching every other
 * service in this codebase's "never trust the guard's own read"
 * discipline — `AcademyScopeGuard` (reused verbatim, unmodified) already
 * proved organization membership before any of these run.
 *
 * Write authorization mirrors `AcademiesService.assertCanManage` exactly:
 * organization membership alone is READ-sufficient (governed entirely by
 * `AcademyScopeGuard`), but WRITE requires an `academy_members` row with
 * role `owner`/`administrator` — never assumed from organization role
 * (master plan P5 §11: "Do not assume Organization Owner = Course Owner").
 */
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import { CoursesRepository } from '../repositories/courses.repository';
import { CourseCategoriesRepository } from '../repositories/course-categories.repository';
import { toCourseResponse } from '../dto/course.contract';
import type { CourseResponse } from '../dto/course.contract';
import { toCourseCategoryResponse } from '../dto/course-category.contract';
import type { CourseCategoryResponse } from '../dto/course-category.contract';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { CourseListQueryDto } from '../dto/course-list-query.dto';
import type { CreateCourseDto } from '../dto/create-course.dto';
import type { UpdateCourseDto } from '../dto/update-course.dto';

/** See `AcademiesService.MANAGING_ROLES` — identical rule, applied here to Course writes. */
const MANAGING_ROLES = new Set(['owner', 'administrator']);

@Injectable()
export class CoursesService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly coursesRepository: CoursesRepository,
    private readonly courseCategoriesRepository: CourseCategoriesRepository,
    private readonly academyMembersRepository: AcademyMembersRepository,
  ) {}

  async list(
    academyId: string,
    organizationId: string,
    query: CourseListQueryDto,
  ): Promise<PaginatedResult<CourseResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.coursesRepository.findManyForAcademy(tx, academyId, {
          search: query.search,
          status: query.status,
          visibility: query.visibility,
          categoryId: query.categoryId,
          pricingType: query.pricingType,
          sortBy: query.sortBy as
            'title' | 'createdAt' | 'updatedAt' | 'publishedAt' | undefined,
          sortDirection: query.sortDirection,
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );

    const withStats = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
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

  async getById(
    courseId: string,
    academyId: string,
    organizationId: string,
  ): Promise<CourseResponse> {
    const { course, totalSections, totalLessons } =
      await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
        const row = await this.coursesRepository.findById(tx, courseId);
        this.assertBelongsToAcademy(row, academyId);
        const [sections, lessons] = await Promise.all([
          this.coursesRepository.countSections(tx, courseId),
          this.coursesRepository.countLessons(tx, courseId),
        ]);
        return { course: row, totalSections: sections, totalLessons: lessons };
      });

    return toCourseResponse(course!, { totalSections, totalLessons });
  }

  async create(
    academyId: string,
    organizationId: string,
    userId: string,
    payload: CreateCourseDto,
  ): Promise<CourseResponse> {
    await this.assertSlugAvailable(academyId, organizationId, payload.slug);

    const course = await this.withSlugConflictHandling(() =>
      this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
        await this.assertCanManage(tx, academyId, userId);

        return this.coursesRepository.create(tx, {
          academy: { connect: { id: academyId } },
          category: payload.categoryId
            ? { connect: { id: payload.categoryId } }
            : undefined,
          title: payload.title,
          slug: payload.slug,
          shortDescription: payload.shortDescription,
          description: payload.description,
          thumbnailUrl: payload.thumbnail,
          visibility: payload.visibility,
          pricingType: payload.pricing.type,
          pricingAmountMinorUnits: toMinorUnits(payload.pricing.amount),
          pricingCurrency:
            payload.pricing.type === 'paid' ? payload.pricing.currency : undefined,
        });
      }),
    );

    return toCourseResponse(course, { totalSections: 0, totalLessons: 0 });
  }

  async update(
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
    payload: UpdateCourseDto,
  ): Promise<CourseResponse> {
    if (payload.slug) {
      await this.assertSlugAvailable(academyId, organizationId, payload.slug, courseId);
    }

    const { course, totalSections, totalLessons } = await this.withSlugConflictHandling(
      () =>
        this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
          await this.assertCanManage(tx, academyId, userId);

          const current = await this.coursesRepository.findById(tx, courseId);
          this.assertBelongsToAcademy(current, academyId);

          const data: Prisma.CourseUpdateInput = {
            title: payload.title,
            slug: payload.slug,
            shortDescription: payload.shortDescription,
            description: payload.description,
            thumbnailUrl: payload.thumbnail,
            visibility: payload.visibility,
            status: payload.status,
            ...(payload.categoryId !== undefined
              ? {
                  category: payload.categoryId
                    ? { connect: { id: payload.categoryId } }
                    : { disconnect: true },
                }
              : {}),
            ...(payload.pricing
              ? {
                  pricingType: payload.pricing.type,
                  // `?? null` (not just `toMinorUnits(...)`): switching to
                  // `free` must actively CLEAR a stale minor-units value
                  // from a previous `paid` state, not merely leave it
                  // untouched — `undefined` means "don't touch this field"
                  // to Prisma's update semantics, which would silently keep
                  // the old price alive underneath a "free" label.
                  pricingAmountMinorUnits: toMinorUnits(payload.pricing.amount) ?? null,
                  pricingCurrency:
                    payload.pricing.type === 'paid' ? payload.pricing.currency : null,
                }
              : {}),
          };

          const updated = await this.coursesRepository.update(tx, courseId, data);
          const [sections, lessons] = await Promise.all([
            this.coursesRepository.countSections(tx, courseId),
            this.coursesRepository.countLessons(tx, courseId),
          ]);
          return { course: updated, totalSections: sections, totalLessons: lessons };
        }),
    );

    return toCourseResponse(course, { totalSections, totalLessons });
  }

  /** `DELETE /academies/:id/courses/:id` — soft-archive via status transition, never a SQL DELETE (no DELETE RLS policy exists on `courses` at all, matching `Academy`'s own precedent). */
  async archive(
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      await this.assertCanManage(tx, academyId, userId);
      const current = await this.coursesRepository.findById(tx, courseId);
      this.assertBelongsToAcademy(current, academyId);
      await this.coursesRepository.update(tx, courseId, { status: 'archived' });
    });
  }

  /**
   * No publication prerequisite is enforced (e.g. "must have at least one
   * section") — none is specified anywhere in the frontend (no such check
   * in `course.schemas.ts`, no such guard in `usePublishCourse`), and
   * master plan P5 §10/§11 explicitly warns against inventing one. Sets
   * `publishedAt` to now on every call, even a republish — matches
   * `CourseService.publishCourse`'s "publishes... making it visible" doc
   * comment as an event each time, not a one-time historical marker.
   */
  async publish(
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<CourseResponse> {
    return this.setPublicationState(
      courseId,
      academyId,
      organizationId,
      userId,
      'published',
      new Date(),
    );
  }

  /** Reverts to `draft`. `publishedAt` is left untouched — an unpublished course still honestly remembers when it was last published, matching common CMS behavior; nothing in the frontend contract asks for it to be cleared. */
  async unpublish(
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<CourseResponse> {
    return this.setPublicationState(
      courseId,
      academyId,
      organizationId,
      userId,
      'draft',
      undefined,
    );
  }

  private async setPublicationState(
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
    status: 'published' | 'draft',
    publishedAt: Date | undefined,
  ): Promise<CourseResponse> {
    const { course, totalSections, totalLessons } =
      await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
        await this.assertCanManage(tx, academyId, userId);
        const current = await this.coursesRepository.findById(tx, courseId);
        this.assertBelongsToAcademy(current, academyId);

        const updated = await this.coursesRepository.update(tx, courseId, {
          status,
          ...(publishedAt ? { publishedAt } : {}),
        });
        const [sections, lessons] = await Promise.all([
          this.coursesRepository.countSections(tx, courseId),
          this.coursesRepository.countLessons(tx, courseId),
        ]);
        return { course: updated, totalSections: sections, totalLessons: lessons };
      });

    return toCourseResponse(course, { totalSections, totalLessons });
  }

  async getCategories(
    academyId: string,
    organizationId: string,
  ): Promise<PaginatedResult<CourseCategoryResponse>> {
    const categories = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.courseCategoriesRepository.findManyForAcademy(tx, academyId),
    );

    const counts = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.courseCategoriesRepository.countCoursesByCategory(
          tx,
          categories.map((c) => c.id),
        ),
    );
    const countByCategoryId = new Map(
      counts.map((c) => [c.categoryId, c._count.categoryId]),
    );

    const items = categories.map((category) =>
      toCourseCategoryResponse(category, countByCategoryId.get(category.id) ?? 0),
    );

    return {
      items,
      pagination: buildPaginationMeta(1, Math.max(items.length, 1), items.length),
    };
  }

  async getCategoryById(
    categoryId: string,
    academyId: string,
    organizationId: string,
  ): Promise<CourseCategoryResponse> {
    const category = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.courseCategoriesRepository.findById(tx, categoryId),
    );

    if (!category || category.academyId !== academyId) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }

    return toCourseCategoryResponse(category);
  }

  /** Enforces the write-authorization rule documented on this class. */
  private async assertCanManage(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<void> {
    const membership = await this.academyMembersRepository.findForUserInAcademy(
      tx,
      academyId,
      userId,
    );
    if (!membership || !MANAGING_ROLES.has(membership.role)) {
      throw new ForbiddenException({ messageKey: 'errors.course.insufficientRole' });
    }
  }

  /** Verifies the full ownership chain (course → academy) — a caller must not be able to reach a course by guessing its id under the wrong academy path. */
  private assertBelongsToAcademy(
    course: { academyId: string } | null,
    academyId: string,
  ): void {
    if (!course || course.academyId !== academyId) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
  }

  private async assertSlugAvailable(
    academyId: string,
    organizationId: string,
    slug: string,
    excludeCourseId?: string,
  ): Promise<void> {
    const existing = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.coursesRepository.findByAcademyAndSlug(tx, academyId, slug),
    );

    // Unlike `academies.slug` (globally unique), `courses.slug` is unique
    // only `(academy_id, slug)` (master plan §5.3) — the lookup above is
    // already scoped to this one academy, so any hit here is a genuine
    // same-academy collision, never an unrelated course elsewhere.
    if (existing && existing.id !== excludeCourseId) {
      throw new ConflictException({ messageKey: 'errors.course.slugTaken' });
    }
  }

  /** Real backstop for the same reason `AcademiesService.withSlugConflictHandling` exists — see that method's doc comment. */
  private async withSlugConflictHandling<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        (error.meta?.target as string[] | undefined)?.includes('slug')
      ) {
        throw new ConflictException({ messageKey: 'errors.course.slugTaken' });
      }
      throw error;
    }
  }
}

/** `undefined`/free pricing has no amount at all; a decimal dollar amount converts to integer minor units (cents), never stored as a float. */
function toMinorUnits(amount: number | undefined): bigint | undefined {
  if (amount === undefined) return undefined;
  return BigInt(Math.round(amount * 100));
}
