/**
 * CoursesService — course CRUD, publish/unpublish, category reads, and
 * (Phase 3, master plan §22/§23) course-level instructor assignment.
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
 * role `owner`/`administrator`/`manager` — never assumed from organization
 * role (master plan P5 §11: "Do not assume Organization Owner = Course
 * Owner"). `assignInstructor`/`removeInstructor` reuse this exact same
 * gate — assigning a course instructor is a course-write action, not a
 * different privilege tier.
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
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { EntitlementEnforcementService } from '../../plans/services/entitlement-enforcement.service';
import { TenantUsageRecomputeProducer } from '../../plans/queue/tenant-usage-recompute.producer';
import { CoursesRepository } from '../repositories/courses.repository';
import { CourseCategoriesRepository } from '../repositories/course-categories.repository';
import { CourseInstructorsRepository } from '../repositories/course-instructors.repository';
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
import {
  PUBLISH_READINESS_ENFORCED,
  assertCourseReady,
  evaluateCourseReadiness,
  readCourseReadinessFacts,
  type CoursePublishReadinessResponse,
} from './course-readiness';

/** See `AcademiesService.MANAGING_ROLES` — identical rule, applied here to Course writes. */
const MANAGING_ROLES = new Set(['owner', 'administrator', 'manager']);

@Injectable()
export class CoursesService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly coursesRepository: CoursesRepository,
    private readonly courseCategoriesRepository: CourseCategoriesRepository,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly courseInstructorsRepository: CourseInstructorsRepository,
    private readonly entitlementEnforcementService: EntitlementEnforcementService,
    private readonly tenantUsageRecomputeProducer: TenantUsageRecomputeProducer,
    private readonly auditLogWriterService: AuditLogWriterService,
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

    // Batched (2 round trips total), not per-course — see
    // `CoursesRepository.countSectionsAndLessonsBatch`'s doc comment.
    const { sectionCounts, lessonCounts } =
      await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
        this.coursesRepository.countSectionsAndLessonsBatch(
          tx,
          items.map((course) => course.id),
        ),
      );
    const withStats = items.map((course) =>
      toCourseResponse(course, {
        totalSections: sectionCounts.get(course.id) ?? 0,
        totalLessons: lessonCounts.get(course.id) ?? 0,
      }),
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
    // W6 — an optional client key makes a retried create (double submit,
    // ambiguous network failure, the http client's own replay) return the
    // course the first request made instead of a misleading "slug taken".
    // Checked BEFORE the slug check: the replayed slug IS taken — by the
    // very course this request already created.
    if (payload.idempotencyKey) {
      const replay = await this.findCreateReplay(
        academyId,
        organizationId,
        userId,
        payload.idempotencyKey,
      );
      if (replay) return replay;
    }

    await this.assertSlugAvailable(academyId, organizationId, payload.slug);

    let course: Awaited<ReturnType<CoursesRepository['create']>>;
    try {
      course = await this.withSlugConflictHandling(() =>
        this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
          const role = await this.assertCanManage(tx, academyId, userId);

          // Phase 2 (Decision 4) — live `courses` limit check, inside the
          // same transaction as the insert below.
          await this.entitlementEnforcementService.assertWithinLimit(
            tx,
            organizationId,
            'courses',
          );

          const created = await this.coursesRepository.create(tx, {
            academy: { connect: { id: academyId } },
            // P60 — record the creator at the moment of creation. Previously
            // this was only recoverable from the audit entry written a few
            // lines below, which made "who built this course" answerable for
            // audited rows and unanswerable for the rest.
            createdBy: { connect: { id: userId } },
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
            // P64 Phase 4 catalog metadata. Scalar-list defaults ([]) mean an
            // omitted `outcomes`/`requirements` simply stays empty.
            level: payload.level,
            language: payload.language,
            ...(payload.outcomes ? { outcomes: payload.outcomes } : {}),
            ...(payload.requirements ? { requirements: payload.requirements } : {}),
            ...(payload.introVideoAssetId
              ? { introVideoAsset: { connect: { id: payload.introVideoAssetId } } }
              : {}),
            creationIdempotencyKey: payload.idempotencyKey,
          });

          await this.auditLogWriterService.write(tx, {
            actorUserId: userId,
            organizationId,
            academyId,
            role,
            action: 'course.created',
            targetType: 'course',
            targetId: created.id,
            targetLabel: created.title,
          });

          return created;
        }),
      );
    } catch (error) {
      // Two requests with the same key raced past the replay check: the
      // loser hits a unique violation (the key's, or the slug's when the
      // slug index is checked first). The winner has committed, so a
      // fresh lookup returns its course.
      if (payload.idempotencyKey) {
        const replay = await this.findCreateReplay(
          academyId,
          organizationId,
          userId,
          payload.idempotencyKey,
        );
        if (replay) return replay;
      }
      throw error;
    }

    // Phase 2 — real reactive usage-recompute trigger (a course change).
    await this.tenantUsageRecomputeProducer.enqueueOne(organizationId);

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
          const role = await this.assertCanManage(tx, academyId, userId);

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
            // P64 Phase 4 catalog metadata. Scalar fields follow the same
            // "undefined means don't touch" rule as the ones above; the
            // scalar lists are replaced wholesale only when the key is sent.
            level: payload.level,
            language: payload.language,
            ...(payload.outcomes !== undefined ? { outcomes: payload.outcomes } : {}),
            ...(payload.requirements !== undefined
              ? { requirements: payload.requirements }
              : {}),
            ...(payload.introVideoAssetId !== undefined
              ? {
                  introVideoAsset: payload.introVideoAssetId
                    ? { connect: { id: payload.introVideoAssetId } }
                    : { disconnect: true },
                }
              : {}),
          };

          const updated = await this.coursesRepository.update(tx, courseId, data);

          // Task 3 — field-level before/after over the catalogue's course
          // diff fields (both rows are full, so untouched fields compare
          // equal and are omitted).
          await this.auditLogWriterService.record(tx, {
            actorUserId: userId,
            organizationId,
            academyId,
            role,
            action: 'course.updated',
            targetType: 'course',
            targetId: courseId,
            targetLabel: updated.title,
            before: current as unknown as Record<string, unknown>,
            after: updated as unknown as Record<string, unknown>,
          });

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
      const role = await this.assertCanManage(tx, academyId, userId);
      const current = await this.coursesRepository.findById(tx, courseId);
      this.assertBelongsToAcademy(current, academyId);
      await this.coursesRepository.update(tx, courseId, { status: 'archived' });

      await this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        organizationId,
        academyId,
        role,
        action: 'course.archived',
        targetType: 'course',
        targetId: courseId,
        targetLabel: current!.title,
      });
    });

    // Phase 2 — real reactive usage-recompute trigger (a course change).
    await this.tenantUsageRecomputeProducer.enqueueOne(organizationId);
  }

  /**
   * W6 — publish readiness for the guided wizard. Same authorization as
   * every course write (`assertCanManage`): readiness reveals draft
   * content counts and the organization's payment-setup state, which the
   * academy's read-only audience has no business seeing. Pure evaluation
   * lives in `course-readiness.ts`, shared with the (dormant) enforcement
   * in `setPublicationState`.
   */
  async getPublishReadiness(
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<CoursePublishReadinessResponse> {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      await this.assertCanManage(tx, academyId, userId);
      return this.readReadiness(tx, courseId, academyId, organizationId);
    });
  }

  private async readReadiness(
    tx: Prisma.TransactionClient,
    courseId: string,
    academyId: string,
    organizationId: string,
  ): Promise<CoursePublishReadinessResponse> {
    const course = await this.coursesRepository.findById(tx, courseId);
    this.assertBelongsToAcademy(course, academyId);
    const facts = await readCourseReadinessFacts(tx, courseId, organizationId);
    return evaluateCourseReadiness(course!, facts);
  }

  /**
   * The course an earlier create with this key made, or null. Authorized
   * like a create (a non-manager cannot probe keys), and only the user who
   * made the course may replay it — the same key from someone else is a
   * conflict, never a way to read another author's draft.
   */
  private async findCreateReplay(
    academyId: string,
    organizationId: string,
    userId: string,
    idempotencyKey: string,
  ): Promise<CourseResponse | null> {
    const found = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId);
        const existing = await this.coursesRepository.findByCreationIdempotencyKey(
          tx,
          academyId,
          idempotencyKey,
        );
        if (!existing) return null;
        if (existing.createdById !== userId) {
          throw new ConflictException({
            messageKey: 'errors.course.idempotencyKeyConflict',
          });
        }
        const [sections, lessons] = await Promise.all([
          this.coursesRepository.countSections(tx, existing.id),
          this.coursesRepository.countLessons(tx, existing.id),
        ]);
        return { course: existing, totalSections: sections, totalLessons: lessons };
      },
    );
    if (!found) return null;
    return toCourseResponse(found.course, {
      totalSections: found.totalSections,
      totalLessons: found.totalLessons,
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
        const role = await this.assertCanManage(tx, academyId, userId);
        const current = await this.coursesRepository.findById(tx, courseId);
        this.assertBelongsToAcademy(current, academyId);

        // W6 — dormant: `PUBLISH_READINESS_ENFORCED` is false in Phase 1, so
        // publishing is unchanged. See `course-readiness.ts` before turning
        // it on (the PATCH `status` bypass must close at the same time).
        if (status === 'published' && PUBLISH_READINESS_ENFORCED) {
          assertCourseReady(
            await this.readReadiness(tx, courseId, academyId, organizationId),
          );
        }

        const updated = await this.coursesRepository.update(tx, courseId, {
          status,
          ...(publishedAt ? { publishedAt } : {}),
        });

        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          organizationId,
          academyId,
          role,
          action: status === 'published' ? 'course.published' : 'course.unpublished',
          targetType: 'course',
          targetId: courseId,
          targetLabel: updated.title,
        });

        const [sections, lessons] = await Promise.all([
          this.coursesRepository.countSections(tx, courseId),
          this.coursesRepository.countLessons(tx, courseId),
        ]);
        return { course: updated, totalSections: sections, totalLessons: lessons };
      });

    return toCourseResponse(course, { totalSections, totalLessons });
  }

  /**
   * Phase 3 (master plan §22/§23, "Instructor <-> Course Assignment") —
   * the one missing write path the Teaching Dashboard, "My Courses", and
   * quiz/assignment grading were already built to consume via
   * `CourseInstructorsRepository.findCourseIdsForInstructor` /
   * `is_course_instructor()` (both reused verbatim, unmodified).
   *
   * CORE RULE this method enforces: Academy instructor-roster membership
   * (`AcademyMember` role `instructor`, granted by `AcademiesService.
   * addInstructor` — a staffing operation) is a PREREQUISITE for course
   * access, never a SUBSTITUTE for it. A course access grant is always a
   * second, explicit, per-course action:
   *
   *   Academy instructor roster -> eligible to teach
   *                              -> explicit course assignment (this method)
   *                              -> can access THIS course
   *
   * Authorization mirrors `assertCanManage` exactly (Owner/Administrator/
   * Manager of the course's OWN academy — never assumed from organization
   * role, never satisfied by membership in a different academy, even in
   * the same organization). The target must independently be an ACTIVE
   * `instructor`-role member of that SAME academy — an instructor from a
   * different academy (or a non-instructor role) is rejected with the
   * same 404 shape as any other cross-academy lookup, never leaking
   * whether the user exists elsewhere.
   *
   * All assigned instructors have equal standing — this method never
   * writes any rank/order/primary flag, because `course_instructors` has
   * none (see its own schema doc comment).
   */
  async assignInstructor(
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
    targetUserId: string,
  ): Promise<CourseResponse> {
    await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const role = await this.assertCanManage(tx, academyId, userId);
      const current = await this.coursesRepository.findById(tx, courseId);
      this.assertBelongsToAcademy(current, academyId);

      const targetMembership = await this.academyMembersRepository.findForUserInAcademy(
        tx,
        academyId,
        targetUserId,
      );
      if (
        !targetMembership ||
        targetMembership.role !== 'instructor' ||
        targetMembership.status !== 'active'
      ) {
        throw new NotFoundException({
          messageKey: 'errors.course.instructorNotEligible',
        });
      }

      const alreadyAssigned = await this.courseInstructorsRepository.isInstructor(
        tx,
        courseId,
        targetUserId,
      );
      if (alreadyAssigned) {
        throw new ConflictException({
          messageKey: 'errors.course.instructorAlreadyAssigned',
        });
      }

      await this.courseInstructorsRepository.create(tx, courseId, targetUserId);

      // Task 3 — the instructor's NAME, so the log reads "assigned Sara to
      // «Chemistry 101»" instead of quoting a user id.
      const instructor = await tx.user.findUnique({
        where: { id: targetUserId },
        select: { name: true },
      });
      await this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        organizationId,
        academyId,
        role,
        action: 'course.instructor_assigned',
        targetType: 'course',
        targetId: courseId,
        targetLabel: current!.title,
        context: { targetUserId, instructorName: instructor?.name ?? null },
      });
    });

    return this.getById(courseId, academyId, organizationId);
  }

  /** Revokes course-level access granted by `assignInstructor` above. Never touches the Academy instructor-roster membership itself — removing someone from a course does not remove them from the Academy (the reverse of the "roster membership does not imply course access" rule: revoking course access does not imply revoking roster membership either). */
  async removeInstructor(
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
    targetUserId: string,
  ): Promise<void> {
    await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const role = await this.assertCanManage(tx, academyId, userId);
      const current = await this.coursesRepository.findById(tx, courseId);
      this.assertBelongsToAcademy(current, academyId);

      const assigned = await this.courseInstructorsRepository.isInstructor(
        tx,
        courseId,
        targetUserId,
      );
      if (!assigned) {
        throw new NotFoundException({
          messageKey: 'errors.course.instructorNotAssigned',
        });
      }

      await this.courseInstructorsRepository.delete(tx, courseId, targetUserId);

      const instructor = await tx.user.findUnique({
        where: { id: targetUserId },
        select: { name: true },
      });
      await this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        organizationId,
        academyId,
        role,
        action: 'course.instructor_removed',
        targetType: 'course',
        targetId: courseId,
        targetLabel: current!.title,
        context: { targetUserId, instructorName: instructor?.name ?? null },
      });
    });
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

  /** Enforces the write-authorization rule documented on this class. Returns the caller's real Academy-membership role (Phase 8) — every call site uses this, rather than re-querying, as the `role` attributed on that mutation's audit-log entry. */
  private async assertCanManage(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<string> {
    const role = await this.academyMembersRepository.findManagingRole(
      tx,
      academyId,
      userId,
      MANAGING_ROLES,
    );
    if (!role) {
      throw new ForbiddenException({ messageKey: 'errors.course.insufficientRole' });
    }
    return role;
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
