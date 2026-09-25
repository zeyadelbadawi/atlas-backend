/**
 * P64 Phase 3 (§D.2, §D.3, §E.7) — the reviewer's side of the quiz engine.
 *
 * Authorization: every method runs under the reviewer's user context and
 * first passes `assertCanReviewCourse` (course instructor OR academy
 * owner/administrator/manager — AD-6). RLS agrees independently through
 * the `*_review_*` tiers (`can_review_course`). Regeneration of the
 * quiz-level result and the course completion happen after a review write
 * in the academy's tenant context, never as the learner.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  Prisma,
  QuizAttempt,
  QuizGradingPolicy,
  QuizStudentOverride,
} from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { CoursesRepository } from '../../course/repositories/courses.repository';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import { AcademiesRepository } from '../../academy/repositories/academies.repository';
import { CourseInstructorsRepository } from '../../course/repositories/course-instructors.repository';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { CommunicationService } from '../../communications/services/communication.service';
import type { EmitResult } from '../../communications/services/communication.service';
import {
  grantedValues,
  revokedValues,
  type QuizExceptionFacts,
} from '../../communications/services/quiz-exception-values.util';
import { LearningMetricsService } from '../../observability/metrics/learning-metrics.service';
import {
  assertCanReviewCourse,
  type CourseReviewContext,
} from '../../learning/services/learning-access.util';
import { QuizzesRepository } from '../../learning/repositories/quizzes.repository';
import { QuizAttemptsRepository } from '../../learning/repositories/quiz-attempts.repository';
import {
  QuizAttemptEngineService,
  toEngineQuestion,
} from '../../learning/services/quiz-attempt-engine.service';
import { CourseCompletionService } from '../../learning/services/course-completion.service';
import {
  aggregateResult,
  scoreAttempt,
  type FinalizedAttemptSummary,
} from '../../learning/services/quiz-engine.util';
import type {
  GradeQuizAttemptDto,
  InvalidateQuizAttemptDto,
  QuizStudentOverrideDto,
} from '../../learning/dto/quiz-attempt-engine.dto';
import {
  INTEGRITY_CSV_HEADER,
  integrityCsvRow,
  toAttemptReviewResponse,
  toOverrideResponse,
  toReviewAnswer,
  type QuizAttemptReviewResponse,
  type QuizStudentOverrideResponse,
} from '../dto/quiz-review.contract';

const MAX_TIME_MULTIPLIER = 4;

/**
 * The override row, in the shape every learner-exception message reads it
 * (`quiz-exception-values.util.ts`).
 *
 * The reviewer's `reason` is deliberately not carried across — see that
 * file's header for why the learner is not mailed the note written about
 * them.
 */
function overrideFacts(
  row: QuizStudentOverride,
  quizTitle: string,
  courseId: string,
): QuizExceptionFacts {
  return {
    overrideId: row.id,
    quizId: row.quizId,
    quizTitle,
    courseId,
    timeMultiplier: row.timeMultiplier,
    extraAttempts: row.extraAttempts,
    availableFrom: row.availableFrom,
    availableUntil: row.availableUntil,
  };
}

@Injectable()
export class QuizReviewService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly coursesRepository: CoursesRepository,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly academiesRepository: AcademiesRepository,
    private readonly courseInstructorsRepository: CourseInstructorsRepository,
    private readonly quizzesRepository: QuizzesRepository,
    private readonly attempts: QuizAttemptsRepository,
    private readonly engine: QuizAttemptEngineService,
    private readonly completion: CourseCompletionService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly communications: CommunicationService,
    private readonly metrics: LearningMetricsService,
  ) {}

  private review(
    tx: Prisma.TransactionClient,
    userId: string,
    courseId: string,
  ): Promise<CourseReviewContext> {
    return assertCanReviewCourse(
      tx,
      this.coursesRepository,
      this.academyMembersRepository,
      this.courseInstructorsRepository,
      userId,
      courseId,
    );
  }

  private async loadAttempt(
    tx: Prisma.TransactionClient,
    courseId: string,
    quizId: string,
    attemptId: string,
  ) {
    const quiz = await this.quizzesRepository.findByIdWithCorrectAnswers(tx, quizId);
    if (!quiz || quiz.courseId !== courseId)
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    const attempt = await tx.quizAttempt.findUnique({
      where: { id: attemptId },
      include: {
        student: { select: { id: true, name: true, email: true } },
        gradedBy: { select: { name: true } },
        invalidatedBy: { select: { name: true } },
      },
    });
    if (!attempt || attempt.quizId !== quizId)
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    return { quiz, attempt };
  }

  async getAttempt(
    userId: string,
    courseId: string,
    quizId: string,
    attemptId: string,
  ): Promise<QuizAttemptReviewResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await this.review(tx, userId, courseId);
      const { quiz, attempt } = await this.loadAttempt(tx, courseId, quizId, attemptId);
      const events = await this.attempts.findEvents(tx, attemptId);
      return this.toReview(attempt, quiz, events);
    });
  }

  private toReview(
    attempt: QuizAttempt & {
      student: { name: string; email: string };
      gradedBy: { name: string } | null;
      invalidatedBy: { name: string } | null;
    },
    quiz: Parameters<QuizAttemptEngineService['attemptQuestions']>[0],
    events: Awaited<ReturnType<QuizAttemptsRepository['findEvents']>>,
  ): QuizAttemptReviewResponse {
    const questions = this.engine.attemptQuestions(quiz, attempt);
    const answers = this.engine.answersOf(attempt);
    const manual = this.engine.manualGradesOf(attempt);
    const byQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));
    const finalized =
      attempt.status !== 'in_progress' && attempt.status !== 'not_started';
    const score = finalized ? scoreAttempt(questions, answers, manual) : null;
    const scoreByQuestion = new Map(
      score?.perQuestion.map((row) => [row.questionId, row]) ?? [],
    );
    return toAttemptReviewResponse(
      attempt,
      attempt.student,
      questions.map((question) =>
        toReviewAnswer(
          question,
          byQuestion.get(question.id),
          scoreByQuestion.get(question.id),
          manual?.[question.id] ?? null,
        ),
      ),
      events,
      {
        gradedBy: attempt.gradedBy?.name ?? null,
        invalidatedBy: attempt.invalidatedBy?.name ?? null,
      },
    );
  }

  /** Manual grading of essay questions. Finalises the attempt once every pending question has points. */
  async gradeAttempt(
    userId: string,
    courseId: string,
    quizId: string,
    attemptId: string,
    dto: GradeQuizAttemptDto,
  ): Promise<QuizAttemptReviewResponse> {
    const now = new Date();
    const result = await this.tenancyContextService.runInUserContext(
      userId,
      async (tx) => {
        const context = await this.review(tx, userId, courseId);
        const { quiz, attempt } = await this.loadAttempt(tx, courseId, quizId, attemptId);
        if (attempt.status === 'in_progress' || attempt.status === 'not_started') {
          throw new ConflictException({ messageKey: 'errors.quiz.attemptNotSubmitted' });
        }
        if (attempt.status === 'invalidated') {
          throw new ConflictException({ messageKey: 'errors.quiz.attemptInvalidated' });
        }
        const questions = this.engine.attemptQuestions(quiz, attempt);
        const essayIds = new Set(
          questions.filter((q) => q.type === 'essay').map((q) => q.id),
        );
        const pointsById = new Map(questions.map((q) => [q.id, q.points]));
        const manual: Record<string, number> = {
          ...(this.engine.manualGradesOf(attempt) ?? {}),
        };
        for (const grade of dto.grades) {
          if (!essayIds.has(grade.questionId)) {
            throw new BadRequestException({
              messageKey: 'errors.quiz.notManuallyGradable',
            });
          }
          const max = pointsById.get(grade.questionId) ?? 0;
          if (grade.points > max) {
            throw new BadRequestException({
              messageKey: 'errors.quiz.pointsExceedMaximum',
              details: { max },
            });
          }
          manual[grade.questionId] = grade.points;
        }
        const answers = this.engine.answersOf(attempt);
        const score = scoreAttempt(questions, answers, manual);
        const passed =
          score.score === null
            ? null
            : quiz.passingScore === null || score.score >= quiz.passingScore;
        const status: QuizAttempt['status'] = score.pendingManual
          ? 'submitted'
          : passed
            ? 'passed'
            : 'failed';
        await this.attempts.update(tx, attemptId, {
          manualGrades: manual,
          pointsEarned: score.pointsEarned,
          pointsTotal: score.pointsTotal,
          score: score.score,
          passed: score.pendingManual ? null : passed,
          status,
          gradingStatus: score.pendingManual ? 'pending' : 'graded',
          gradedBy: { connect: { id: userId } },
          gradedAt: now,
        });
        const organizationId = await this.academiesRepository.resolveOrganizationId(
          context.academyId,
        );
        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          organizationId: organizationId ?? undefined,
          academyId: context.academyId,
          role: context.reviewerRole,
          action: 'quiz_attempt.graded',
          targetType: 'quiz_attempt',
          targetId: attemptId,
          targetLabel: attempt.student.name,
          context: {
            courseId,
            quizId,
            score: score.score,
            finalized: !score.pendingManual,
          },
        });
        const enrollment = await tx.enrollment.findFirst({
          where: { studentId: attempt.studentId, courseId },
          select: { id: true, academyId: true },
        });
        let emitted: EmitResult = { created: false, outboxId: null };
        if (!score.pendingManual) {
          emitted = await this.communications.emit(tx, {
            key: 'assessment.quiz.graded',
            recipientUserId: attempt.studentId,
            organizationId,
            academyId: context.academyId,
            entity: { type: 'quiz_attempt', id: attemptId },
            values: { quizTitle: quiz.title, score: score.score, courseId, quizId },
          });
        }
        return {
          quiz,
          attempt,
          enrollment,
          finalized: !score.pendingManual,
          emitted,
          score: score.score,
        };
      },
    );

    if (result.finalized) {
      this.metrics.recordQuizAttemptSubmitted('review');
      await this.regenerateResult(
        userId,
        result.quiz,
        result.attempt.studentId,
        result.enrollment,
      );
      await this.communications.enqueueAfterCommit(result.emitted.outboxId);
    }
    return this.getAttempt(userId, courseId, quizId, attemptId);
  }

  /** Void (invalidate) an attempt: it no longer counts toward any result. Audited. */
  async invalidateAttempt(
    userId: string,
    courseId: string,
    quizId: string,
    attemptId: string,
    dto: InvalidateQuizAttemptDto,
  ): Promise<QuizAttemptReviewResponse> {
    const now = new Date();
    const result = await this.tenancyContextService.runInUserContext(
      userId,
      async (tx) => {
        const context = await this.review(tx, userId, courseId);
        const { quiz, attempt } = await this.loadAttempt(tx, courseId, quizId, attemptId);
        if (attempt.status === 'invalidated') {
          return { quiz, attempt, enrollment: null, changed: false, emitted: undefined };
        }
        await this.attempts.update(tx, attemptId, {
          status: 'invalidated',
          invalidatedAt: now,
          invalidatedBy: { connect: { id: userId } },
          invalidationReason: dto.reason,
          ...(attempt.status === 'in_progress' ? { submittedAt: now } : {}),
        });
        const organizationId = await this.academiesRepository.resolveOrganizationId(
          context.academyId,
        );
        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          organizationId: organizationId ?? undefined,
          academyId: context.academyId,
          role: context.reviewerRole,
          action: 'quiz_attempt.invalidated',
          targetType: 'quiz_attempt',
          targetId: attemptId,
          targetLabel: attempt.student.name,
          context: {
            courseId,
            quizId,
            reason: dto.reason,
            previousStatus: attempt.status,
          },
        });
        const enrollment = await tx.enrollment.findFirst({
          where: { studentId: attempt.studentId, courseId },
          select: { id: true, academyId: true },
        });

        // P64 Communications C3 (plan §8 E5, §10 "E4 auto-submitted, E5
        // invalidated | yes (high) | preference"). The LEARNER is told,
        // not the reviewer who clicked — and inside the same transaction
        // as the status change and the audit row, so a void that rolls
        // back tells nobody. `invalidatedAtMs` is the `now` already
        // written to the row, so a retried request reproduces the key.
        const academy = await tx.academy.findUnique({
          where: { id: context.academyId },
          select: { name: true },
        });
        const emitted = await this.communications.emit(tx, {
          key: 'assessment.attempt.invalidated',
          recipientUserId: attempt.studentId,
          organizationId: organizationId ?? undefined,
          academyId: context.academyId,
          entity: { type: 'quiz_attempt', id: attemptId },
          values: {
            invalidatedAtMs: now.getTime(),
            quizTitle: quiz.title,
            reason: dto.reason ?? '',
            academyName: academy?.name ?? '',
            courseId,
            quizId,
          },
        });
        return { quiz, attempt, enrollment, changed: true, emitted };
      },
    );
    if (result.changed) {
      await this.regenerateResult(
        userId,
        result.quiz,
        result.attempt.studentId,
        result.enrollment,
      );
      await this.communications.enqueueAfterCommit(result.emitted?.outboxId ?? null);
    }
    return this.getAttempt(userId, courseId, quizId, attemptId);
  }

  /**
   * After a review write: re-aggregate the quiz result under the reviewer's
   * own context (the review tier may write `quiz_results`), then re-evaluate
   * course completion in the academy's tenant context (the reviewer's
   * context has no UPDATE tier on progress — by design).
   */
  private async regenerateResult(
    reviewerId: string,
    quiz: {
      id: string;
      courseId: string;
      gradingPolicy: QuizGradingPolicy;
      passingScore: number | null;
    },
    studentId: string,
    enrollment: { id: string; academyId: string } | null,
  ): Promise<void> {
    await this.tenancyContextService.runInUserContext(reviewerId, async (tx) => {
      const rows = await tx.quizAttempt.findMany({
        where: {
          quizId: quiz.id,
          studentId,
          status: { in: ['submitted', 'passed', 'failed', 'expired'] },
        },
        orderBy: { attemptNumber: 'asc' },
      });
      const summaries: FinalizedAttemptSummary[] = rows.map((row) => ({
        id: row.id,
        attemptNumber: row.attemptNumber,
        score: row.score !== null ? Number(row.score) : null,
        passed: row.passed,
        submittedAt: row.submittedAt ?? row.createdAt,
        pendingGrading: row.gradingStatus === 'pending',
      }));
      await this.attempts.upsertResult(
        tx,
        quiz.id,
        studentId,
        aggregateResult(quiz.gradingPolicy, summaries, quiz.passingScore),
      );
    });
    if (enrollment) {
      await this.completion.recomputeInTenantContext({
        enrollmentId: enrollment.id,
        academyId: enrollment.academyId,
      });
    }
  }

  // --- overrides -------------------------------------------------------------

  async listOverrides(
    userId: string,
    courseId: string,
    quizId: string,
  ): Promise<QuizStudentOverrideResponse[]> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await this.review(tx, userId, courseId);
      const quiz = await this.quizzesRepository.findAnyByIdWithQuestions(
        tx,
        courseId,
        quizId,
      );
      if (!quiz) throw new NotFoundException({ messageKey: 'errors.notFound' });
      const rows = await this.attempts.findOverridesForQuiz(tx, quizId);
      const users = await tx.user.findMany({
        where: { id: { in: rows.map((row) => row.studentId) } },
        select: { id: true, name: true },
      });
      const names = new Map(users.map((user) => [user.id, user.name]));
      return rows.map((row) => toOverrideResponse(row, names.get(row.studentId) ?? null));
    });
  }

  async upsertOverride(
    userId: string,
    courseId: string,
    quizId: string,
    dto: QuizStudentOverrideDto,
  ): Promise<QuizStudentOverrideResponse> {
    const multiplier = dto.timeMultiplier ?? 1;
    if (
      !Number.isFinite(multiplier) ||
      multiplier < 1 ||
      multiplier > MAX_TIME_MULTIPLIER
    ) {
      throw new BadRequestException({ messageKey: 'errors.quiz.invalidTimeMultiplier' });
    }
    /*
      THE GRANT INSTANT, COMPUTED ONCE (§19 "events that legitimately
      repeat carry a version in the key").

      It is read twice — as the dedupe key's version, and as the "is this
      window open yet?" comparison — and the two MUST agree. A second
      `new Date()` inside the transaction could fall the other side of an
      `availableFrom` that is milliseconds away, producing a message that
      says "you can use it now" under a key that says it was scheduled.
    */
    const grantedAt = new Date();
    const result = await this.tenancyContextService.runInUserContext(
      userId,
      async (tx) => {
        const context = await this.review(tx, userId, courseId);
        const quiz = await this.quizzesRepository.findAnyByIdWithQuestions(
          tx,
          courseId,
          quizId,
        );
        if (!quiz) throw new NotFoundException({ messageKey: 'errors.notFound' });
        // The student must be enrolled in this course; the review tier makes
        // the enrollment visible only for courses the reviewer may review.
        const enrollment = await tx.enrollment.findFirst({
          where: { studentId: dto.studentId, courseId },
          select: { id: true, student: { select: { name: true } } },
        });
        if (!enrollment) throw new NotFoundException({ messageKey: 'errors.notFound' });
        const row = await this.attempts.upsertOverride(
          tx,
          quizId,
          dto.studentId,
          userId,
          {
            timeMultiplier: multiplier,
            extraAttempts: dto.extraAttempts ?? 0,
            availableFrom: dto.availableFrom ? new Date(dto.availableFrom) : null,
            availableUntil: dto.availableUntil ? new Date(dto.availableUntil) : null,
            reason: dto.reason ?? null,
          },
        );
        const organizationId = await this.academiesRepository.resolveOrganizationId(
          context.academyId,
        );
        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          organizationId: organizationId ?? undefined,
          academyId: context.academyId,
          role: context.reviewerRole,
          action: 'quiz.override.updated',
          targetType: 'quiz_student_override',
          targetId: row.id,
          targetLabel: enrollment.student.name,
          context: {
            courseId,
            quizId,
            studentId: dto.studentId,
            timeMultiplier: multiplier,
            extraAttempts: dto.extraAttempts ?? 0,
          },
        });
        /*
          Tell the student — the person the accommodation exists for.

          The recipient is `row.studentId`, read back from the row that
          was just written, never `dto.studentId`: the row is the only
          authority on whose exception this is, and a recipient taken
          from a request body is one validation gap away from mailing
          another academy's learner. Inside this transaction, so a later
          failure takes the message with it.
        */
        const emitted = await this.communications.emit(tx, {
          key: 'assessment.exception.granted',
          recipientUserId: row.studentId,
          organizationId,
          academyId: context.academyId,
          entity: { type: 'quiz_student_override', id: row.id },
          values: grantedValues(overrideFacts(row, quiz.title, courseId), grantedAt),
        });
        return { row, studentName: enrollment.student.name, emitted };
      },
    );
    await this.communications.enqueueAfterCommit(result.emitted.outboxId);
    return toOverrideResponse(result.row, result.studentName);
  }

  async deleteOverride(
    userId: string,
    courseId: string,
    quizId: string,
    studentId: string,
  ): Promise<void> {
    /* The revocation instant, computed once — see `upsertOverride`. */
    const revokedAt = new Date();
    const emitted = await this.tenancyContextService.runInUserContext(
      userId,
      async (tx) => {
        const context = await this.review(tx, userId, courseId);
        const quiz = await this.quizzesRepository.findAnyByIdWithQuestions(
          tx,
          courseId,
          quizId,
        );
        if (!quiz) throw new NotFoundException({ messageKey: 'errors.notFound' });
        /*
          Read the row BEFORE deleting it. Its id is the entity the
          communication is keyed to and its `studentId` is the recipient;
          after the DELETE neither exists to be read, and reconstructing
          the recipient from the URL would be taking it from the request.
          It is also what makes a delete of something that was never there
          silent: no row, no message.
        */
        const existing = await this.attempts.findOverride(tx, quizId, studentId);
        const deleted = await this.attempts.deleteOverride(tx, quizId, studentId);
        if (deleted === 0 || !existing) return { created: false, outboxId: null };
        const organizationId = await this.academiesRepository.resolveOrganizationId(
          context.academyId,
        );
        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          organizationId: organizationId ?? undefined,
          academyId: context.academyId,
          role: context.reviewerRole,
          action: 'quiz.override.removed',
          targetType: 'quiz_student_override',
          targetId: `${quizId}:${studentId}`,
          context: { courseId, quizId, studentId },
        });
        return this.communications.emit(tx, {
          key: 'assessment.exception.revoked',
          recipientUserId: existing.studentId,
          organizationId,
          academyId: context.academyId,
          entity: { type: 'quiz_student_override', id: existing.id },
          values: revokedValues(overrideFacts(existing, quiz.title, courseId), revokedAt),
        });
      },
    );
    await this.communications.enqueueAfterCommit(emitted.outboxId);
  }

  // --- integrity export ---------------------------------------------------------

  async integrityCsv(userId: string, courseId: string, quizId: string): Promise<string> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await this.review(tx, userId, courseId);
      const quiz = await this.quizzesRepository.findAnyByIdWithQuestions(
        tx,
        courseId,
        quizId,
      );
      if (!quiz) throw new NotFoundException({ messageKey: 'errors.notFound' });
      const attempts = await tx.quizAttempt.findMany({
        where: { quizId },
        include: { student: { select: { name: true, email: true } } },
        orderBy: [{ createdAt: 'desc' }],
        take: 5_000,
      });
      const counts = await tx.quizAttemptEvent.groupBy({
        by: ['attemptId', 'type'],
        where: { attemptId: { in: attempts.map((a) => a.id) }, counted: true },
        _count: { _all: true },
      });
      const byAttempt = new Map<string, Record<string, number>>();
      for (const row of counts) {
        const bucket = byAttempt.get(row.attemptId) ?? {};
        bucket[row.type] = row._count._all;
        byAttempt.set(row.attemptId, bucket);
      }
      const lines = [INTEGRITY_CSV_HEADER];
      for (const attempt of attempts) {
        lines.push(
          integrityCsvRow(
            attempt,
            attempt.student.name,
            attempt.student.email,
            byAttempt.get(attempt.id) ?? {},
          ),
        );
      }
      return `${lines.join('\r\n')}\r\n`;
    });
  }
}

export { toEngineQuestion };
