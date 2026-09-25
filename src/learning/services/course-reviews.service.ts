/**
 * CourseReviewsService — the authenticated course-review surface (P64
 * Phase 4, master plan §D.4/§G/§O):
 *   - an ENROLLED learner authors, edits and deletes their own single
 *     review of a course; every edit resets it to `pending` so a moderator
 *     re-approves changed content;
 *   - the course's REVIEWER (assigned instructor, or the owning academy's
 *     active owner/administrator/manager) lists every status, approves or
 *     rejects, and may remove a review from their course.
 *
 * Every method runs under `runInUserContext` so PostgreSQL RLS
 * (`app.current_user_id`) is the second, independent gate: the service's
 * `assertActiveEnrollment` / `assertCanReviewCourse` guard and the
 * `course_reviews_*` RLS policies must both pass, so a guard bug can never
 * widen access past the row-level policy and vice-versa. Nothing here
 * resolves an organization id or trusts a caller-supplied academy id — the
 * academy is read from the course row itself.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { EnrollmentsRepository } from '../repositories/enrollments.repository';
import { CourseReviewsRepository } from '../repositories/course-reviews.repository';
import { CoursesRepository } from '../../course/repositories/courses.repository';
import { CourseInstructorsRepository } from '../../course/repositories/course-instructors.repository';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import { AcademyStudentsRepository } from '../../tenancy/repositories/academy-students.repository';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { CommunicationService } from '../../communications/services/communication.service';
import { AcademyStaffRecipientsService } from '../../communications/services/academy-staff-recipients.service';
import type { EmitResult } from '../../communications/services/communication.service';
import { assertActiveEnrollment, assertCanReviewCourse } from './learning-access.util';
import type {
  CreateCourseReviewDto,
  UpdateCourseReviewDto,
} from '../dto/course-review.dto';
import { toCourseReviewResponse } from '../dto/course-review.contract';
import type { CourseReviewResponse } from '../dto/course-review.contract';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import type { CourseReview } from '@prisma/client';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Minimal, dependency-free sanitisation for stored review bodies (master
 * plan §I "review content sanitized"): strip control characters and angle
 * brackets so a body can never carry markup into a page that renders it,
 * and collapse surrounding whitespace. Rendering layers still escape; this
 * is defence at rest, not a substitute for output encoding.
 */
function sanitizeBody(body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  const cleaned = Array.from(body)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      // Drop C0/DEL control characters, keeping tab/newline/carriage-return
      // as legitimate body whitespace.
      if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return false;
      return code !== 0x7f;
    })
    .join('')
    .replace(/[<>]/g, '')
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

@Injectable()
export class CourseReviewsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly courseReviewsRepository: CourseReviewsRepository,
    private readonly enrollmentsRepository: EnrollmentsRepository,
    private readonly coursesRepository: CoursesRepository,
    private readonly courseInstructorsRepository: CourseInstructorsRepository,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly academyStudentsRepository: AcademyStudentsRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly communicationService: CommunicationService,
    private readonly staffRecipients: AcademyStaffRecipientsService,
  ) {}

  // ------------------------------------------------------------------
  // Learner (author) surface
  // ------------------------------------------------------------------

  /**
   * Create the caller's review, or replace their existing one for the same
   * course (the `@@unique([courseId, studentId])` makes at most one exist).
   * Requires an active enrollment; always lands `pending` for moderation.
   */
  async createMyReview(
    userId: string,
    courseId: string,
    dto: CreateCourseReviewDto,
  ): Promise<CourseReviewResponse> {
    // Computed ONCE, before the transaction, so a retry re-derives the
    // same dedupe key instead of minting a new work item each attempt.
    const submittedAt = new Date();
    const outboxIds: (string | null)[] = [];

    const response = await this.tenancyContextService.runInUserContext(
      userId,
      async (tx) => {
        const enrollment = await assertActiveEnrollment(
          tx,
          this.enrollmentsRepository,
          userId,
          courseId,
          this.academyStudentsRepository,
        );

        const existing = await this.courseReviewsRepository.findByStudentAndCourse(
          tx,
          userId,
          courseId,
        );
        const body = sanitizeBody(dto.body);

        const review = existing
          ? await this.courseReviewsRepository.update(tx, existing.id, {
              rating: dto.rating,
              body: body ?? null,
              // A re-submission must be re-moderated: never let an edit keep a
              // stale `approved`.
              status: 'pending',
            })
          : await this.courseReviewsRepository.create(tx, {
              courseId,
              academyId: enrollment.academyId,
              studentId: userId,
              rating: dto.rating,
              body: body ?? null,
              status: 'pending',
            });

        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          academyId: enrollment.academyId,
          role: 'student',
          action: existing ? 'course_review.updated' : 'course_review.created',
          targetType: 'course_review',
          targetId: review.id,
          targetLabel: courseId,
        });

        // The review is `pending` and invisible until a moderator acts, so
        // somebody has to be told. This runs inside the LEARNER's
        // transaction — which is the point: the work item is atomic with
        // the review, so a crash between them cannot leave a review that
        // nobody knows to moderate. A learner cannot read
        // `academy_members`, hence the definer-backed lookup.
        //
        // `academyName` is deliberately NOT passed: a learner context
        // cannot read `academies` either (there is no student policy, so
        // the relation throws rather than returning null), and the
        // dispatcher resolves the academy's branding itself.
        const course = await this.coursesRepository.findById(tx, courseId);
        const moderators = await this.staffRecipients.moderators(
          tx,
          enrollment.academyId,
        );
        for (const moderatorUserId of moderators) {
          // A moderator reviewing their own academy's course should not be
          // told about their own submission.
          if (moderatorUserId === userId) continue;
          const emitted = await this.communicationService.emit(tx, {
            key: 'review.submitted',
            recipientUserId: moderatorUserId,
            academyId: enrollment.academyId,
            entity: { type: 'course_review', id: review.id },
            values: {
              submittedAtMs: submittedAt.getTime(),
              courseId,
              courseTitle: course?.title ?? '',
              // The moderation queue is per-course on the management
              // surface, so the link needs the academy too. The rule
              // context only sees `{ entity, values }`, which is why this
              // is carried here rather than read from `academyId` above.
              academyId: enrollment.academyId,
            },
          });
          outboxIds.push(emitted.outboxId);
        }

        return toCourseReviewResponse(review);
      },
    );

    for (const outboxId of outboxIds) {
      await this.communicationService.enqueueAfterCommit(outboxId);
    }
    return response;
  }

  /** Partial edit of the caller's own review; resets it to `pending`. */
  async updateMyReview(
    userId: string,
    courseId: string,
    dto: UpdateCourseReviewDto,
  ): Promise<CourseReviewResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const existing = await this.courseReviewsRepository.findByStudentAndCourse(
        tx,
        userId,
        courseId,
      );
      if (!existing) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }
      const body = dto.body !== undefined ? sanitizeBody(dto.body) : undefined;
      const review = await this.courseReviewsRepository.update(tx, existing.id, {
        ...(dto.rating !== undefined ? { rating: dto.rating } : {}),
        ...(dto.body !== undefined ? { body: body ?? null } : {}),
        status: 'pending',
      });

      await this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        academyId: existing.academyId,
        role: 'student',
        action: 'course_review.updated',
        targetType: 'course_review',
        targetId: review.id,
        targetLabel: courseId,
      });

      return toCourseReviewResponse(review);
    });
  }

  /** The caller's own review for a course, or `null` if they have none. */
  async getMyReview(
    userId: string,
    courseId: string,
  ): Promise<CourseReviewResponse | null> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const existing = await this.courseReviewsRepository.findByStudentAndCourse(
        tx,
        userId,
        courseId,
      );
      return existing ? toCourseReviewResponse(existing) : null;
    });
  }

  /** The caller deletes their own review. */
  async deleteMyReview(userId: string, courseId: string): Promise<void> {
    await this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const existing = await this.courseReviewsRepository.findByStudentAndCourse(
        tx,
        userId,
        courseId,
      );
      if (!existing) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }
      await this.courseReviewsRepository.deleteById(tx, existing.id);
      await this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        academyId: existing.academyId,
        role: 'student',
        action: 'course_review.deleted',
        targetType: 'course_review',
        targetId: existing.id,
        targetLabel: courseId,
      });
    });
  }

  // ------------------------------------------------------------------
  // Reviewer (moderation) surface
  // ------------------------------------------------------------------

  /** Every status of a course's reviews, for the course's reviewer. */
  async listForModeration(
    userId: string,
    courseId: string,
    query: { page?: number; pageSize?: number; status?: CourseReview['status'] },
  ): Promise<PaginatedResult<CourseReviewResponse>> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await assertCanReviewCourse(
        tx,
        this.coursesRepository,
        this.academyMembersRepository,
        this.courseInstructorsRepository,
        userId,
        courseId,
      );
      const page = query.page ?? DEFAULT_PAGE;
      const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
      const { items, totalItems } = await this.courseReviewsRepository.listByCourse(
        tx,
        courseId,
        {
          skip: (page - 1) * pageSize,
          take: pageSize,
          status: query.status,
        },
      );
      return {
        items: items.map(toCourseReviewResponse),
        pagination: buildPaginationMeta(page, pageSize, totalItems),
      };
    });
  }

  approve(
    userId: string,
    courseId: string,
    reviewId: string,
  ): Promise<CourseReviewResponse> {
    return this.moderate(userId, courseId, reviewId, 'approved');
  }

  reject(
    userId: string,
    courseId: string,
    reviewId: string,
  ): Promise<CourseReviewResponse> {
    return this.moderate(userId, courseId, reviewId, 'rejected');
  }

  private async moderate(
    userId: string,
    courseId: string,
    reviewId: string,
    status: 'approved' | 'rejected',
  ): Promise<CourseReviewResponse> {
    let emitted: EmitResult = { created: false, outboxId: null };
    const response = await this.tenancyContextService.runInUserContext(
      userId,
      async (tx) => {
        const context = await assertCanReviewCourse(
          tx,
          this.coursesRepository,
          this.academyMembersRepository,
          this.courseInstructorsRepository,
          userId,
          courseId,
        );
        const existing = await this.courseReviewsRepository.findById(tx, reviewId);
        // Belt-and-braces: the review must exist AND belong to the course the
        // caller is authorised to moderate. RLS already scopes the read; this
        // stops a valid reviewer of course A from moderating course B's row.
        if (!existing || existing.courseId !== courseId) {
          throw new NotFoundException({ messageKey: 'errors.notFound' });
        }
        const review = await this.courseReviewsRepository.update(tx, reviewId, {
          status,
        });
        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          academyId: context.academyId,
          role: context.reviewerRole,
          action:
            status === 'approved' ? 'course_review.approved' : 'course_review.rejected',
          targetType: 'course_review',
          targetId: reviewId,
          targetLabel: courseId,
        });

        // P64 Communications C3 (plan §8 F2, §10 "learner: yes | never —
        // low stakes; feed only"). The AUTHOR is told, in the feed only:
        // emailing someone that their review was rejected reads as a
        // reprimand, and emailing that it was approved is noise. Same
        // transaction as the status write, so a rolled-back moderation
        // tells nobody. Never emitted to the moderator acting here — the
        // recipient is read from the review row, not from the request.
        const course = await this.coursesRepository.findById(tx, courseId);
        emitted = await this.communicationService.emit(tx, {
          key: 'review.moderated',
          recipientUserId: existing.studentId,
          academyId: context.academyId,
          entity: { type: 'course_review', id: reviewId },
          values: { status, courseId, courseTitle: course?.title ?? '' },
        });
        return toCourseReviewResponse(review);
      },
    );
    await this.communicationService.enqueueAfterCommit(emitted.outboxId);
    return response;
  }

  /** A reviewer removes a review from their course. */
  async removeAsReviewer(
    userId: string,
    courseId: string,
    reviewId: string,
  ): Promise<void> {
    await this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const context = await assertCanReviewCourse(
        tx,
        this.coursesRepository,
        this.academyMembersRepository,
        this.courseInstructorsRepository,
        userId,
        courseId,
      );
      const existing = await this.courseReviewsRepository.findById(tx, reviewId);
      if (!existing || existing.courseId !== courseId) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }
      await this.courseReviewsRepository.deleteById(tx, reviewId);
      await this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        academyId: context.academyId,
        role: context.reviewerRole,
        action: 'course_review.removed',
        targetType: 'course_review',
        targetId: reviewId,
        targetLabel: courseId,
      });
    });
  }
}
