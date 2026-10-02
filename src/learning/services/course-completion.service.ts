/**
 * P64 Phase 3 (AD-11) — the one place course completion is decided.
 *
 * Called after every write that can change the answer: a lesson
 * completed or un-completed, a quiz attempt finalised, an assignment
 * graded, an attempt voided. It gathers the server-held evidence, runs
 * the pure evaluator and materialises `course_progress.completion_state`,
 * `completed_at`, `overall_score` and `certificate_status`, plus the
 * enrollment's `completed` status — then, when the learner has just become
 * certificate-eligible, enqueues the issuance check.
 *
 * Context discipline: the CALLER chooses the transaction context. A
 * learner's own write (lesson, quiz submit) recomputes inside the
 * learner's user context (self policies). A reviewer's write recomputes
 * in the academy's TENANT context after the reviewer's transaction
 * commits (`recomputeInTenantContext`), because a reviewer's user context
 * has no UPDATE tier on progress by design.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type { CourseCompletionState, Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademiesRepository } from '../../academy/repositories/academies.repository';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import { AcademyStudentsRepository } from '../../tenancy/repositories/academy-students.repository';
import { EnrollmentsRepository } from '../repositories/enrollments.repository';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { CommunicationService } from '../../communications/services/communication.service';
import { assertActiveEnrollment } from './learning-access.util';
import type { UpdateCompletionRuleDto } from '../dto/completion-rule.dto';
import type {
  CourseCompletionResponse,
  CourseCompletionRuleResponse,
} from '../dto/completion.contract';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  evaluateCompletion,
  parseCompletionRule,
  type AssignmentEvidence,
  type CompletionEvaluation,
  type CompletionRule,
  type QuizEvidence,
} from './completion-rule.util';
import {
  CERTIFICATE_ISSUE_JOB,
  CERTIFICATE_JOBS_QUEUE,
  type CertificateIssueJobPayload,
} from '../../certificates/queue/certificate-jobs.types';

/**
 * Overall course progress across the WHOLE unified sequence — lessons,
 * quizzes and assignments — not lessons alone.
 *
 * P4 Issue 4: the `/me` ring stayed at 0 for a learner whose progress was a
 * passed quiz or a submitted assignment, and mis-stated it for any course
 * that is not lesson-only, because `course_progress.percentage` counted only
 * lessons and `recompute` never even wrote it. This is the one definition of
 * "how far through the course am I" — a finished item is a completed lesson,
 * a passed (or submitted-and-awaiting-grade) quiz, or a submitted assignment,
 * matching what the player sequence treats as finished.
 */
export function computeItemProgress(args: {
  readonly lessons: { readonly total: number; readonly completed: number };
  readonly quizzes: readonly {
    readonly passed: boolean;
    readonly pendingGrading: boolean;
  }[];
  readonly assignments: readonly { readonly submitted: boolean }[];
}): { completed: number; total: number; percentage: number } {
  const total = args.lessons.total + args.quizzes.length + args.assignments.length;
  const completed =
    args.lessons.completed +
    args.quizzes.filter((quiz) => quiz.passed || quiz.pendingGrading).length +
    args.assignments.filter((assignment) => assignment.submitted).length;
  return { completed, total, percentage: total > 0 ? (completed / total) * 100 : 0 };
}

export interface CompletionRecomputeResult {
  readonly evaluation: CompletionEvaluation;
  readonly rule: CompletionRule;
  readonly certificateStatus: 'unavailable' | 'eligible' | 'issued' | 'revoked';
  readonly certificatesEnabled: boolean;
  readonly certificateMinScore: number | null;
  readonly becameEligible: boolean;
  /**
   * P64 Communications C3 (plan §8 E6) — the "you finished this course"
   * outbox row, set only on the recompute that made completion TRUE for
   * an enrollment that was not complete before. `null` on every other
   * recompute, which is nearly all of them. Callers hand it to
   * `enqueueAfterCommit` once their transaction has committed; a caller
   * that does not is not a bug — the one-minute sweep finds the row.
   */
  readonly outboxId: string | null;
}

interface EnrollmentRef {
  readonly id: string;
  readonly studentId: string;
  readonly courseId: string;
  readonly academyId: string;
  readonly status: string;
}

@Injectable()
export class CourseCompletionService {
  private readonly logger = new Logger(CourseCompletionService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly academiesRepository: AcademiesRepository,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly academyStudentsRepository: AcademyStudentsRepository,
    private readonly enrollmentsRepository: EnrollmentsRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
    @InjectQueue(CERTIFICATE_JOBS_QUEUE) private readonly certificateQueue: Queue,
    private readonly communications: CommunicationService,
  ) {}

  /** Evidence + evaluation only — no writes. Used by the learner completion screen. */
  async evaluate(
    tx: Prisma.TransactionClient,
    enrollment: EnrollmentRef,
  ): Promise<
    Omit<
      CompletionRecomputeResult,
      'becameEligible' | 'certificateStatus' | 'outboxId'
    > & {
      readonly currentCertificateStatus:
        'unavailable' | 'eligible' | 'issued' | 'revoked';
      readonly completionState: 'incomplete' | 'in_progress' | 'completed';
      readonly completedAt: Date | null;
      readonly itemProgress: { completed: number; total: number; percentage: number };
    }
  > {
    const course = await tx.course.findUnique({
      where: { id: enrollment.courseId },
      select: {
        completionRule: true,
        certificatesEnabled: true,
        certificateMinScore: true,
      },
    });
    const rule = parseCompletionRule(course?.completionRule);
    const [lessonRows, quizzes, results, assignments, submissions, progress] =
      await Promise.all([
        tx.lessonProgress.findMany({
          where: { enrollmentId: enrollment.id },
          select: { status: true },
        }),
        tx.quiz.findMany({
          where: { courseId: enrollment.courseId, status: 'published' },
          select: { id: true, title: true, requiredForCompletion: true },
        }),
        tx.quizResult.findMany({
          where: {
            studentId: enrollment.studentId,
            quiz: { courseId: enrollment.courseId },
          },
        }),
        tx.assignment.findMany({
          where: { courseId: enrollment.courseId, status: 'published' },
          select: { id: true, title: true, requiredForCompletion: true },
        }),
        tx.assignmentSubmission.findMany({
          where: {
            studentId: enrollment.studentId,
            assignment: { courseId: enrollment.courseId },
          },
          select: { assignmentId: true, status: true, gradingStatus: true, score: true },
        }),
        tx.courseProgress.findUnique({
          where: { enrollmentId: enrollment.id },
          select: { certificateStatus: true, completionState: true, completedAt: true },
        }),
      ]);

    const resultByQuiz = new Map(results.map((row) => [row.quizId, row]));
    const quizEvidence: QuizEvidence[] = quizzes.map((quiz) => {
      const result = resultByQuiz.get(quiz.id);
      return {
        quizId: quiz.id,
        title: quiz.title,
        required: quiz.requiredForCompletion,
        passed: result?.passed ?? false,
        effectiveScore:
          result?.effectiveScore !== null && result?.effectiveScore !== undefined
            ? Number(result.effectiveScore)
            : null,
        pendingGrading: result?.pendingGrading ?? false,
      };
    });
    const submissionByAssignment = new Map(
      submissions.map((row) => [row.assignmentId, row]),
    );
    const assignmentEvidence: AssignmentEvidence[] = assignments.map((assignment) => {
      const submission = submissionByAssignment.get(assignment.id);
      const graded = submission?.gradingStatus === 'graded';
      return {
        assignmentId: assignment.id,
        title: assignment.title,
        required: assignment.requiredForCompletion,
        submitted: submission?.status === 'submitted' || graded,
        graded,
        score:
          graded && submission?.score !== null && submission?.score !== undefined
            ? Number(submission.score)
            : null,
      };
    });

    const evaluation = evaluateCompletion(
      rule,
      {
        total: lessonRows.length,
        completed: lessonRows.filter((row) => row.status === 'completed').length,
      },
      quizEvidence,
      assignmentEvidence,
    );

    const itemProgress = computeItemProgress({
      lessons: {
        total: lessonRows.length,
        completed: lessonRows.filter((row) => row.status === 'completed').length,
      },
      quizzes: quizEvidence,
      assignments: assignmentEvidence,
    });

    return {
      evaluation,
      rule,
      certificatesEnabled: course?.certificatesEnabled ?? false,
      certificateMinScore: course?.certificateMinScore ?? null,
      currentCertificateStatus: progress?.certificateStatus ?? 'unavailable',
      completionState: progress?.completionState ?? 'incomplete',
      completedAt: progress?.completedAt ?? null,
      itemProgress,
    };
  }

  /**
   * Recompute and MATERIALISE inside the caller's transaction. The caller
   * guarantees the context can write `course_progress` and `enrollments`
   * for this enrollment (learner self-context or academy tenant context).
   */
  async recompute(
    tx: Prisma.TransactionClient,
    enrollment: EnrollmentRef,
    now: Date = new Date(),
  ): Promise<CompletionRecomputeResult> {
    const evaluated = await this.evaluate(tx, enrollment);
    const {
      evaluation,
      rule,
      certificatesEnabled,
      certificateMinScore,
      currentCertificateStatus,
    } = evaluated;

    const completed = evaluation.completed;
    const minScoreMet =
      certificateMinScore === null ||
      (evaluation.overallScore !== null &&
        evaluation.overallScore >= certificateMinScore);

    // Certificate status is a lifecycle: `issued`/`revoked` are facts owned
    // by the certificate row and are never overwritten here (D7: a later
    // change of evidence never silently touches an issued certificate).
    let certificateStatus = currentCertificateStatus;
    if (
      currentCertificateStatus === 'unavailable' ||
      currentCertificateStatus === 'eligible'
    ) {
      certificateStatus =
        completed && certificatesEnabled && minScoreMet ? 'eligible' : 'unavailable';
    }
    const becameEligible =
      certificateStatus === 'eligible' && currentCertificateStatus !== 'eligible';

    const completionState: CourseCompletionState = completed
      ? 'completed'
      : evaluation.lessons.completed > 0 ||
          evaluation.requiredQuizzes.some((q) => q.effectiveScore !== null) ||
          evaluation.requiredAssignments.some((a) => a.submitted)
        ? 'in_progress'
        : 'incomplete';

    // Not an upsert: under FORCE RLS an INSERT … ON CONFLICT is checked
    // against the INSERT policies first, and the tenant context (reviewer
    // path) holds no INSERT tier on course_progress by design.
    const progressData = {
      completionState,
      completedAt: completed ? (evaluated.completedAt ?? now) : null,
      overallScore: evaluation.overallScore,
      certificateStatus,
      // P4 Issue 4 — the authoritative overall-progress figure the `/me` ring
      // reads, across the whole sequence, not lessons alone. Materialised here
      // so every recompute (lesson complete, quiz finalize, assignment submit
      // or grade) keeps it live.
      percentage: evaluated.itemProgress.percentage,
      // …and the counts it is computed from, so no surface has to show a
      // percentage beside lesson-only counts ("0 of 0" for a quiz course).
      totalItems: evaluated.itemProgress.total,
      completedItems: evaluated.itemProgress.completed,
    };
    const updated = await tx.courseProgress.updateMany({
      where: { enrollmentId: enrollment.id },
      data: progressData,
    });
    if (updated.count === 0) {
      await tx.courseProgress.create({
        data: {
          enrollmentId: enrollment.id,
          totalLessons: evaluation.lessons.total,
          completedLessons: evaluation.lessons.completed,
          // `percentage` is the full-sequence figure from `progressData`.
          ...progressData,
        },
      });
    }

    // The enrollment's own status follows: `completed` when the rule is met,
    // back to `enrolled` when a void or an undo takes it away. Written
    // through a SECURITY DEFINER that changes exactly those two columns —
    // the caller is either the learner (own progress) or the academy's
    // tenant context (after a reviewer's write); no wide UPDATE tier exists.
    const becameComplete = completed && enrollment.status === 'enrolled';
    if (becameComplete || (!completed && enrollment.status === 'completed')) {
      await tx.$executeRaw`SELECT set_enrollment_completion(${enrollment.id}, ${completed})`;
    }

    // P64 Communications C3 (plan §8 E6, §10 "E6 course completed | yes |
    // preference (engagement-positive) — pairs with certificate").
    //
    // The GUARD is the transition, not `completed`: this method runs
    // after every lesson tick, every finalised attempt and every grade,
    // and `completed` stays true for the rest of the enrollment's life.
    // Emitting on the state rather than the edge would congratulate a
    // learner on every subsequent page view — the dedupe key would
    // swallow the duplicates, but only after writing a row and burning a
    // savepoint each time.
    //
    // Deliberately NOT `always`: `certificate.issued`, enqueued a few
    // lines below for the same moment, is the email that must arrive.
    let outboxId: string | null = null;
    if (becameComplete) {
      const completedAt = progressData.completedAt ?? now;
      // The course TITLE only, and deliberately not the academy's name.
      //
      // This recompute runs in the LEARNER's own user context on the
      // lesson-completion path, and there is no `academies_student_select`
      // policy — an academy_students row is not an academy_members row —
      // so the academy is invisible here. Asking for it through the
      // REQUIRED `course.academy` relation does not return null, it
      // THROWS ("Field academy is required to return data, got null"),
      // which would turn finishing a course into a 500. The email's brand
      // name comes from `CommunicationBrandingService`, which resolves it
      // with full visibility after the commit.
      const course = await tx.course.findUnique({
        where: { id: enrollment.courseId },
        select: { title: true },
      });
      const emitted = await this.communications.emit(tx, {
        key: 'course.completed',
        recipientUserId: enrollment.studentId,
        academyId: enrollment.academyId,
        entity: { type: 'enrollment', id: enrollment.id },
        values: {
          completedAtMs: completedAt.getTime(),
          courseId: enrollment.courseId,
          courseTitle: course?.title ?? '',
          overallScore:
            evaluation.overallScore === null ? '' : Math.round(evaluation.overallScore),
        },
      });
      outboxId = emitted.outboxId;
    }

    if (becameEligible) {
      await this.enqueueIssuance(enrollment.id, enrollment.academyId);
    }

    return {
      evaluation,
      rule,
      certificateStatus,
      certificatesEnabled,
      certificateMinScore,
      becameEligible,
      outboxId,
    };
  }

  /**
   * For reviewer-driven writes: recompute AFTER the reviewer's transaction
   * commits, in the academy's tenant context. The caller passes the
   * enrollment's academy id it already read under its own (review-tier)
   * context; the organization is resolved through the SECURITY DEFINER
   * lookup, never taken from the request.
   */
  async recomputeInTenantContext(ref: {
    readonly enrollmentId: string;
    readonly academyId: string;
  }): Promise<CompletionRecomputeResult | null> {
    const organizationId = await this.academiesRepository.resolveOrganizationId(
      ref.academyId,
    );
    if (!organizationId) return null;
    const result = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        const row = await tx.enrollment.findUnique({
          where: { id: ref.enrollmentId },
          select: {
            id: true,
            studentId: true,
            courseId: true,
            academyId: true,
            status: true,
          },
        });
        if (!row) return null;
        return this.recompute(tx, row);
      },
    );
    // Step 2, after the tenant-context transaction above has committed.
    await this.communications.enqueueAfterCommit(result?.outboxId ?? null);
    return result;
  }

  // ---------------------------------------------------------------------
  // learner completion screen (§E.5)
  // ---------------------------------------------------------------------

  async learnerView(userId: string, courseId: string): Promise<CourseCompletionResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const enrollment = await assertActiveEnrollment(
        tx,
        this.enrollmentsRepository,
        userId,
        courseId,
        this.academyStudentsRepository,
      );
      const course = await tx.course.findUnique({
        where: { id: courseId },
        select: { title: true },
      });
      if (!course) throw new NotFoundException({ messageKey: 'errors.notFound' });
      const evaluated = await this.evaluate(tx, enrollment);
      const certificate = await tx.certificate.findUnique({
        where: { enrollmentId: enrollment.id },
        select: {
          id: true,
          serial: true,
          verificationCode: true,
          renderStatus: true,
          issuedAt: true,
          status: true,
        },
      });
      return {
        courseId,
        courseTitle: course.title,
        completed: evaluated.completionState === 'completed',
        completedAt: evaluated.completedAt?.toISOString() ?? null,
        completionState: evaluated.completionState,
        overallScore: evaluated.evaluation.overallScore,
        rule: evaluated.rule,
        lessons: evaluated.evaluation.lessons,
        quizzes: evaluated.evaluation.requiredQuizzes,
        assignments: evaluated.evaluation.requiredAssignments,
        missing: evaluated.evaluation.missing,
        certificate: {
          // Follows the course's own certificate configuration, not a
          // rollout allowlist (P4 Issue F).
          enabled: evaluated.certificatesEnabled,
          status: evaluated.currentCertificateStatus,
          minScore: evaluated.certificateMinScore,
          certificateId: certificate?.id ?? null,
          serial: certificate?.serial ?? null,
          verificationCode: certificate?.verificationCode ?? null,
          renderStatus: certificate?.renderStatus ?? null,
          issuedAt: certificate?.issuedAt?.toISOString() ?? null,
        },
      };
    });
  }

  // ---------------------------------------------------------------------
  // staff: the rule (owner / manager)
  // ---------------------------------------------------------------------

  private async assertCanManageCourseRule(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<string> {
    const membership = await this.academyMembersRepository.findForUserInAcademy(
      tx,
      academyId,
      userId,
    );
    if (!membership || !['owner', 'administrator', 'manager'].includes(membership.role)) {
      throw new ForbiddenException({ messageKey: 'errors.course.insufficientRole' });
    }
    return membership.role;
  }

  async staffView(
    academyId: string,
    organizationId: string,
    userId: string,
    courseId: string,
  ): Promise<CourseCompletionRuleResponse> {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      await this.assertCanManageCourseRule(tx, academyId, userId);
      return this.buildStaffView(tx, academyId, courseId);
    });
  }

  private async buildStaffView(
    tx: Prisma.TransactionClient,
    academyId: string,
    courseId: string,
  ): Promise<CourseCompletionRuleResponse> {
    const course = await tx.course.findFirst({
      where: { id: courseId, academyId },
      select: {
        id: true,
        completionRule: true,
        certificatesEnabled: true,
        certificateMinScore: true,
        certificateTemplateId: true,
      },
    });
    if (!course) throw new NotFoundException({ messageKey: 'errors.notFound' });
    const [quizzes, assignments, publishedLessons] = await Promise.all([
      tx.quiz.findMany({
        where: { courseId },
        select: { id: true, title: true, status: true, requiredForCompletion: true },
        orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      }),
      tx.assignment.findMany({
        where: { courseId },
        select: { id: true, title: true, status: true, requiredForCompletion: true },
        orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      }),
      tx.courseLesson.count({ where: { courseId, status: 'published' } }),
    ]);
    return {
      courseId,
      rule: parseCompletionRule(course.completionRule),
      certificatesEnabled: course.certificatesEnabled,
      certificateMinScore: course.certificateMinScore,
      certificateTemplateId: course.certificateTemplateId,
      // Certificates are a standard capability now: any academy may award them
      // by configuring the template and enabling the course toggle. This no
      // longer depends on a rollout allowlist (P4 Issue F), so the owner's
      // "Issue certificate" course toggle is never falsely disabled.
      certificatesFeatureEnabled: true,
      quizzes,
      assignments,
      publishedLessons,
    };
  }

  async updateRule(
    academyId: string,
    organizationId: string,
    userId: string,
    courseId: string,
    dto: UpdateCompletionRuleDto,
  ): Promise<CourseCompletionRuleResponse> {
    if (
      typeof dto.lessons === 'number' &&
      (!Number.isInteger(dto.lessons) || dto.lessons < 0)
    ) {
      throw new BadRequestException({ messageKey: 'errors.validation.failed' });
    }
    // Tenant + user context: the course row is written under the tenant tier,
    // the quiz/assignment `required_for_completion` flags under the author tier
    // (`quizzes_author_update` / `assignments_author_update`), which is a user
    // policy — a tenant-only context would silently update zero rows.
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        const role = await this.assertCanManageCourseRule(tx, academyId, userId);
        const course = await tx.course.findFirst({
          where: { id: courseId, academyId },
          select: {
            id: true,
            title: true,
            completionRule: true,
            certificatesEnabled: true,
            certificateMinScore: true,
            certificateTemplateId: true,
          },
        });
        if (!course) throw new NotFoundException({ messageKey: 'errors.notFound' });
        const current = parseCompletionRule(course.completionRule);
        const next: CompletionRule = {
          lessons: dto.lessons ?? current.lessons,
          requiredQuizzes: dto.requiredQuizzes ?? current.requiredQuizzes,
          requiredAssignments: dto.requiredAssignments ?? current.requiredAssignments,
          minOverallScore:
            dto.minOverallScore === undefined
              ? current.minOverallScore
              : dto.minOverallScore,
        };
        if (dto.certificateTemplateId) {
          const template = await tx.certificateTemplate.findFirst({
            where: { id: dto.certificateTemplateId, academyId },
            select: { id: true },
          });
          if (!template)
            throw new BadRequestException({
              messageKey: 'errors.certificate.templateNotFound',
            });
        }
        await tx.course.update({
          where: { id: courseId },
          data: {
            completionRule: next as unknown as Prisma.InputJsonValue,
            ...(dto.certificatesEnabled !== undefined
              ? { certificatesEnabled: dto.certificatesEnabled }
              : {}),
            ...(dto.certificateMinScore !== undefined
              ? { certificateMinScore: dto.certificateMinScore }
              : {}),
            ...(dto.certificateTemplateId !== undefined
              ? { certificateTemplateId: dto.certificateTemplateId }
              : {}),
          },
        });
        if (dto.requiredQuizIds) {
          await tx.quiz.updateMany({
            where: { courseId },
            data: { requiredForCompletion: false },
          });
          if (dto.requiredQuizIds.length > 0) {
            await tx.quiz.updateMany({
              where: { courseId, id: { in: dto.requiredQuizIds } },
              data: { requiredForCompletion: true },
            });
          }
        }
        if (dto.requiredAssignmentIds) {
          await tx.assignment.updateMany({
            where: { courseId },
            data: { requiredForCompletion: false },
          });
          if (dto.requiredAssignmentIds.length > 0) {
            await tx.assignment.updateMany({
              where: { courseId, id: { in: dto.requiredAssignmentIds } },
              data: { requiredForCompletion: true },
            });
          }
        }
        const organization =
          await this.academiesRepository.resolveOrganizationId(academyId);
        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          organizationId: organization ?? undefined,
          academyId,
          role,
          action: 'course.completion_rule.updated',
          targetType: 'course',
          targetId: courseId,
          targetLabel: course.title,
          context: {
            lessons: String(next.lessons),
            requiredQuizzes: next.requiredQuizzes,
            requiredAssignments: next.requiredAssignments,
            minOverallScore: next.minOverallScore,
            certificatesEnabled: dto.certificatesEnabled ?? course.certificatesEnabled,
            certificateMinScore:
              dto.certificateMinScore === undefined
                ? course.certificateMinScore
                : dto.certificateMinScore,
          },
        });
        return this.buildStaffView(tx, academyId, courseId);
      },
    );
  }

  private async enqueueIssuance(enrollmentId: string, academyId: string): Promise<void> {
    const payload: CertificateIssueJobPayload = { enrollmentId, academyId };
    try {
      await this.certificateQueue.add(CERTIFICATE_ISSUE_JOB, payload, {
        jobId: `certificate-issue:${enrollmentId}:${Date.now()}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 3_000 },
        removeOnComplete: true,
        removeOnFail: { count: 1_000 },
      });
    } catch (error) {
      this.logger.warn(
        { enrollmentId, error: error instanceof Error ? error.message : String(error) },
        'Could not enqueue the certificate issuance check; a staff member can issue manually.',
      );
    }
  }
}
