/**
 * EnrollmentsService — matches `EnrollmentService` (atlas frontend)
 * exactly. Enrollment is always the current authenticated student's own —
 * `studentId` is resolved from `authContext.userId` by the controller,
 * never accepted as a request parameter (master plan §5.3's explicit
 * rule for `enrollments`).
 *
 * Free-course-only for THIS service's own `createEnrollment` entry point,
 * by explicit master plan instruction (P6 §21: "no payment gate on
 * enrollment yet ... free-course behavior is fully buildable now,
 * paid-course gating lands in P13"). A paid course's enrollment attempt
 * through `POST /enrollments` is rejected outright (403) — granting free
 * access to paid content would be a real security/business bug.
 *
 * `createEnrollmentInTransaction` (Phase P13 addition) is the same
 * enrollment-materialization logic — Enrollment row + `CourseProgress` +
 * per-lesson `LessonProgress`, sequential-unlock included — extracted so
 * `CourseCommerceModule`'s successful-paid-course-payment path can reuse
 * it verbatim inside its OWN already-open transaction, instead of
 * duplicating this logic a second time (this codebase's explicit "reuse
 * the existing architecture" rule). `createEnrollment` below is refactored
 * to call it, with zero behavior change to the free-enrollment flow —
 * proven by the pre-existing P6 enrollment test suite passing unchanged.
 */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Enrollment, Prisma } from '@prisma/client';
import type { CourseWithRelations } from '../../course/repositories/courses.repository';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { CoursesRepository } from '../../course/repositories/courses.repository';
import { CourseSectionsRepository } from '../../course/repositories/course-sections.repository';
import { AcademyStudentsRepository } from '../../tenancy/repositories/academy-students.repository';
import { EntitlementEnforcementService } from '../../plans/services/entitlement-enforcement.service';
import { TenantUsageRecomputeProducer } from '../../plans/queue/tenant-usage-recompute.producer';
import { EnrollmentsRepository } from '../repositories/enrollments.repository';
import { CourseProgressRepository } from '../repositories/course-progress.repository';
import { toEnrollmentResponse } from '../dto/enrollment.contract';
import type { EnrollmentResponse } from '../dto/enrollment.contract';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type { CreateEnrollmentDto } from '../dto/create-enrollment.dto';
import { deriveCompletionState } from './progress-computation.util';

@Injectable()
export class EnrollmentsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly enrollmentsRepository: EnrollmentsRepository,
    private readonly courseProgressRepository: CourseProgressRepository,
    private readonly coursesRepository: CoursesRepository,
    private readonly courseSectionsRepository: CourseSectionsRepository,
    private readonly academyStudentsRepository: AcademyStudentsRepository,
    private readonly entitlementEnforcementService: EntitlementEnforcementService,
    private readonly tenantUsageRecomputeProducer: TenantUsageRecomputeProducer,
  ) {}

  async list(
    userId: string,
    query: CollectionQueryDto,
  ): Promise<PaginatedResult<EnrollmentResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInUserContext(
      userId,
      (tx) =>
        this.enrollmentsRepository.findManyForStudent(tx, userId, {
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );

    return {
      items: items.map(toEnrollmentResponse),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  /** Returns `null` (never 404) when no enrollment exists — matches `EnrollmentService.getEnrollmentForCourse`'s own `Enrollment | null` return type exactly: "not enrolled yet" is a normal, valid state, not an error. */
  async getForCourse(
    userId: string,
    courseId: string,
  ): Promise<EnrollmentResponse | null> {
    const enrollment = await this.tenancyContextService.runInUserContext(userId, (tx) =>
      this.enrollmentsRepository.findByStudentAndCourse(tx, userId, courseId),
    );
    return enrollment ? toEnrollmentResponse(enrollment) : null;
  }

  async createEnrollment(
    userId: string,
    payload: CreateEnrollmentDto,
  ): Promise<EnrollmentResponse> {
    // Phase 2 — the live `students` entitlement check below needs real
    // organization-scoped RLS access (`tenant_subscriptions`, and every
    // table `EntitlementEnforcementService.assertWithinLimit`'s live count
    // reads), which a bare `runInUserContext` never grants. Resolving the
    // course's Academy — and, from that, its Organization — BEFORE
    // opening any transaction (both contextless, safe reads; see
    // `resolveAcademyIdForPublishedCourse`'s own doc comment) lets the
    // entire rest of this method run inside one real
    // `runInTenantAndUserContext`, exactly like `AcademyScopeGuard`'s own
    // "bootstrap, then reestablish with full context" precedent —
    // preserving single-transaction atomicity for every write below.
    const academyId = await this.coursesRepository.resolveAcademyIdForPublishedCourse(
      payload.courseId,
    );
    if (!academyId) throw new NotFoundException({ messageKey: 'errors.notFound' });

    const organizationId =
      await this.academyStudentsRepository.resolveOrganizationId(academyId);
    if (!organizationId) throw new NotFoundException({ messageKey: 'errors.notFound' });

    return this.tenancyContextService
      .runInTenantAndUserContext(organizationId, userId, async (tx) => {
        const course = await this.coursesRepository.findPublishedById(
          tx,
          payload.courseId,
        );
        if (!course) throw new NotFoundException({ messageKey: 'errors.notFound' });

        if (course.pricingType === 'paid') {
          throw new ForbiddenException({
            messageKey: 'errors.enrollment.paidCourseRequiresPayment',
          });
        }

        // Phase 1 (Extended Scope, Decision 11, dependency D) — a student
        // may only enroll into a course owned by an Academy they hold a
        // real `academy_students` membership for (populated at
        // registration through that Academy's own public website, or by
        // a Manager/Owner explicitly creating the account for that
        // Academy). This is the application-layer twin of
        // `enrollments_self_insert`'s RLS check — checked here first so
        // a genuine mismatch surfaces as a clean, typed error instead of
        // a raw RLS-denial database error (this codebase's standard
        // "app-layer check backstopped by RLS, never the other way
        // around" discipline).
        const membership = await this.academyStudentsRepository.findForUserInAcademy(
          tx,
          course.academyId,
          userId,
        );
        if (!membership) {
          throw new ForbiddenException({
            messageKey: 'errors.enrollment.academyMembershipRequired',
          });
        }

        const existing = await this.enrollmentsRepository.findByStudentAndCourse(
          tx,
          userId,
          course.id,
        );
        // Idempotent: re-clicking "Enroll" on an already-enrolled course
        // returns the existing enrollment rather than erroring — and,
        // deliberately, WITHOUT re-checking the entitlement limit: an
        // already-enrolled student consumes no additional seat, so this
        // can never be blocked by a limit reached after they first
        // enrolled.
        if (existing) return toEnrollmentResponse(existing);

        // Phase 2 (Decision 4) — live `students` limit check, inside the
        // same transaction as the enrollment insert below. Placed after
        // every authorization/idempotency check above, matching
        // `AcademiesService.addInstructor`'s identical ordering: a
        // request that was never going to succeed for another reason
        // reports THAT reason first. `additionalStudents` is 0 (never 1)
        // when this student already holds another real enrollment
        // anywhere in this organization — see
        // `EnrollmentsRepository.countActiveForStudentInOrganization`'s
        // own doc comment for why: a second/third course enrollment for
        // an already-counted student must never be blocked as if it were
        // a brand-new one.
        const alreadyCounted =
          await this.enrollmentsRepository.countActiveForStudentInOrganization(
            tx,
            organizationId,
            userId,
          );
        await this.entitlementEnforcementService.assertWithinLimit(
          tx,
          organizationId,
          'students',
          alreadyCounted > 0 ? 0 : 1,
        );

        const enrollment = await this.createEnrollmentInTransaction(tx, userId, course);
        return toEnrollmentResponse(enrollment);
      })
      .then(async (response) => {
        // Phase 2 — real reactive usage-recompute trigger (an enrollment
        // change) — enqueued unconditionally; the idempotent-return branch
        // above (already enrolled) causes no harm here either, a redundant
        // recompute produces byte-identical results.
        await this.tenantUsageRecomputeProducer.enqueueOne(organizationId);
        return response;
      });
  }

  /**
   * Transaction-scoped enrollment materialization — see this class's own
   * doc comment. Callers own the transaction (and therefore the RLS
   * context it runs under, and any pre-checks such as "is this course
   * actually paid-for" or "does an enrollment already exist") — this
   * method does none of that itself, matching `PaymentApplicationService`'s
   * identical "takes an already-open `Prisma.TransactionClient`, never
   * opens its own context" rule for exactly the same reason: it is always
   * one step of a larger atomic transaction, never the whole of one.
   */
  async createEnrollmentInTransaction(
    tx: Prisma.TransactionClient,
    studentId: string,
    course: Pick<CourseWithRelations, 'id' | 'academyId'>,
  ): Promise<Enrollment> {
    const enrollment = await this.enrollmentsRepository.create(tx, {
      student: { connect: { id: studentId } },
      course: { connect: { id: course.id } },
      academyId: course.academyId,
      status: 'enrolled',
      enrolledAt: new Date(),
    });

    const sections = await this.courseSectionsRepository.findManyForCourse(tx, course.id);
    const publishedLessons = sections.flatMap((section) =>
      section.lessons
        .filter((lesson) => lesson.status === 'published')
        .map((lesson) => ({ id: lesson.id, sectionId: section.id })),
    );

    await this.courseProgressRepository.createCourseProgress(tx, {
      enrollment: { connect: { id: enrollment.id } },
      totalLessons: publishedLessons.length,
      completedLessons: 0,
      percentage: 0,
      currentLessonId: publishedLessons[0]?.id,
      completionState: deriveCompletionState(0, publishedLessons.length),
      certificateStatus: 'unavailable',
    });

    if (publishedLessons.length > 0) {
      await this.courseProgressRepository.createManyLessonProgress(
        tx,
        publishedLessons.map((lesson, index) => ({
          enrollmentId: enrollment.id,
          lessonId: lesson.id,
          sectionId: lesson.sectionId,
          courseId: course.id,
          // Sequential curriculum unlock: only the first lesson (in
          // section/lesson order — the exact order `findManyForCourse`
          // already returns) starts available; every later lesson stays
          // locked until the one before it is completed
          // (`CourseProgressService.completeLesson`). Derived directly
          // from the `order` columns' own purpose — see this module's
          // doc comment for the full reasoning; `LessonProgressStatus`
          // structurally requires some rule to produce `locked` at all,
          // and no prerequisite/sequencing field exists to derive a
          // different one from.
          status: index === 0 ? 'available' : 'locked',
        })),
      );
    }

    return enrollment;
  }
}
