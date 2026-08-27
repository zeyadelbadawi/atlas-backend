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
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const course = await this.coursesRepository.findPublishedById(tx, payload.courseId);
      if (!course) throw new NotFoundException({ messageKey: 'errors.notFound' });

      if (course.pricingType === 'paid') {
        throw new ForbiddenException({
          messageKey: 'errors.enrollment.paidCourseRequiresPayment',
        });
      }

      const existing = await this.enrollmentsRepository.findByStudentAndCourse(
        tx,
        userId,
        course.id,
      );
      // Idempotent: re-clicking "Enroll" on an already-enrolled course
      // returns the existing enrollment rather than erroring.
      if (existing) return toEnrollmentResponse(existing);

      const enrollment = await this.createEnrollmentInTransaction(tx, userId, course);
      return toEnrollmentResponse(enrollment);
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
