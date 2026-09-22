/**
 * P64 Phase 3 (AD-8, AD-9) — the server-authoritative attempt lifecycle.
 *
 * start → (resume | autosave | events)* → submit | auto-submit → results.
 *
 * Every step re-checks the seven entitlement conditions through
 * `assertActiveEnrollment` (identity, academy membership, active
 * non-revoked non-expired enrollment, published course) — a refused
 * learner cannot save into, submit, or read an attempt, and an attempt
 * is only ever touched by its own student (RLS self policies agree).
 *
 * The clock is the server's. The deadline is computed once at start
 * from the settings SNAPSHOT (so an author editing the quiz mid-attempt
 * changes nothing for attempts already running), stored on the row, and
 * enforced with a fixed grace on every save and submit. Expiry grades
 * whatever the server last confirmed and never auto-fails.
 *
 * Flags (§S): `quiz.engine_v2` off → attempts run exactly as before
 * Phase 3 (no deadline, no shuffle, all questions, exact coverage required
 * on submit, integrity off). `quiz.integrity` gates the integrity tier
 * independently, and even when on nothing counts until an author sets the
 * quiz's mode above `off`.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  Prisma,
  Quiz,
  QuizAttempt,
  QuizQuestion,
  QuizQuestionOption,
} from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyStudentsRepository } from '../../tenancy/repositories/academy-students.repository';
import { EnrollmentsRepository } from '../repositories/enrollments.repository';
import { CoursesRepository } from '../../course/repositories/courses.repository';
import { QuizzesRepository } from '../repositories/quizzes.repository';
import { QuizAttemptsRepository } from '../repositories/quiz-attempts.repository';
import { FeatureFlagsService } from '../../common/flags/feature-flags.service';
import { LearningMetricsService } from '../../observability/metrics/learning-metrics.service';
import { QuizDeadlineProducer } from '../queue/quiz-deadline.producer';
import { CourseCompletionService } from './course-completion.service';
import { assertActiveEnrollment } from './learning-access.util';
import {
  aggregateResult,
  buildAttemptPlan,
  canStartAttempt,
  computeDeadline,
  decideIntegrity,
  isPassing,
  isPastGrace,
  remainingSeconds,
  resolveDisclosure,
  resolveWindow,
  scoreAttempt,
  validateAnswers,
  type AttemptAnswer,
  type Disclosure,
  type EngineQuestion,
  type FinalizedAttemptSummary,
  type QuizSettingsSnapshot,
} from './quiz-engine.util';
import {
  toQuizAttemptResponse,
  type QuizAttemptResponse,
} from '../dto/quiz-attempt.contract';
import {
  settingsToResponse,
  toAnswerResponse,
  toResultQuestion,
  toSessionQuestion,
  type QuizAttemptResultsResponse,
  type QuizAttemptSessionResponse,
  type RecordEventsResponse,
  type SaveAnswersResponse,
} from '../dto/quiz-attempt-session.contract';
import type {
  RecordQuizAttemptEventsDto,
  SaveQuizAnswersDto,
  SubmitQuizAttemptV2Dto,
} from '../dto/quiz-attempt-engine.dto';

type QuizWithQuestions = Quiz & {
  questions: (QuizQuestion & { options: QuizQuestionOption[] })[];
};

export type FinalizeReason = 'submit' | 'timeout' | 'integrity';

export interface FinalizeOutcome {
  readonly attempt: QuizAttempt;
  readonly pendingGrading: boolean;
}

const ANSWER_VALIDATION_KEYS: Record<string, string> = {
  unknownQuestion: 'errors.quiz.invalidOption',
  duplicateQuestion: 'errors.quiz.invalidOption',
  invalidOption: 'errors.quiz.invalidOption',
  textTooLong: 'errors.quiz.answerTooLong',
  wrongAnswerShape: 'errors.quiz.invalidOption',
};

@Injectable()
export class QuizAttemptEngineService {
  private readonly logger = new Logger(QuizAttemptEngineService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly enrollmentsRepository: EnrollmentsRepository,
    private readonly academyStudentsRepository: AcademyStudentsRepository,
    private readonly coursesRepository: CoursesRepository,
    private readonly quizzesRepository: QuizzesRepository,
    private readonly attempts: QuizAttemptsRepository,
    private readonly featureFlags: FeatureFlagsService,
    private readonly metrics: LearningMetricsService,
    private readonly deadlines: QuizDeadlineProducer,
    private readonly completion: CourseCompletionService,
  ) {}

  // ---------------------------------------------------------------------
  // start / resume
  // ---------------------------------------------------------------------

  async start(
    userId: string,
    courseId: string,
    quizId: string,
  ): Promise<QuizAttemptResponse> {
    const now = new Date();
    const academyId =
      await this.coursesRepository.resolveAcademyIdForPublishedCourse(courseId);
    if (!academyId) throw new NotFoundException({ messageKey: 'errors.notFound' });
    const engineV2 = this.featureFlags.isEnabledForAcademy('quizEngineV2', academyId);
    const integrityOn = this.featureFlags.isEnabledForAcademy('quizIntegrity', academyId);

    const { attempt, quiz, scheduled } =
      await this.tenancyContextService.runInUserContext(userId, async (tx) => {
        const enrollment = await assertActiveEnrollment(
          tx,
          this.enrollmentsRepository,
          userId,
          courseId,
          this.academyStudentsRepository,
        );
        const quizRow = await this.quizzesRepository.findByIdWithCorrectAnswers(
          tx,
          quizId,
        );
        if (!quizRow || quizRow.courseId !== courseId || quizRow.status !== 'published') {
          throw new NotFoundException({ messageKey: 'errors.notFound' });
        }
        // Serialises concurrent starts for this enrollment (Phase 1 race fix).
        await this.enrollmentsRepository.lockForUpdate(tx, enrollment.id);
        const open = await this.quizzesRepository.findOpenAttemptForStudent(
          tx,
          userId,
          quizId,
        );
        if (open) {
          // Resume. An expired open attempt is finalised first so the
          // learner never resumes into a dead paper.
          if (isPastGrace(open.deadlineAt, now)) {
            await this.finalizeInTransaction(tx, open, quizRow, {
              reason: 'timeout',
              now,
              enrollment,
            });
            const finalized = await this.attempts.findById(tx, open.id);
            throw new ConflictException({
              messageKey: 'errors.quiz.attemptExpired',
              details: { attemptId: finalized?.id ?? open.id },
            });
          }
          return { attempt: open, quiz: quizRow, scheduled: null };
        }

        const override = await this.attempts.findOverride(tx, quizId, userId);
        const existingCount = await this.attempts.countForStudent(tx, userId, quizId);
        if (
          !canStartAttempt(
            existingCount,
            quizRow.maxAttempts,
            override?.extraAttempts ?? 0,
          )
        ) {
          throw new ForbiddenException({ messageKey: 'errors.quiz.maxAttemptsReached' });
        }

        const window = engineV2
          ? resolveWindow({
              now,
              availableFrom: override?.availableFrom ?? quizRow.availableFrom,
              availableUntil: override?.availableUntil ?? quizRow.availableUntil,
              dueAt: quizRow.dueAt,
              latePolicy: quizRow.latePolicy,
            })
          : 'open';
        if (window === 'not_yet_open') {
          throw new ForbiddenException({ messageKey: 'errors.quiz.notYetAvailable' });
        }
        if (window === 'closed') {
          throw new ForbiddenException({ messageKey: 'errors.quiz.windowClosed' });
        }
        if (window === 'late_blocked') {
          throw new ForbiddenException({ messageKey: 'errors.quiz.pastDue' });
        }

        const timeMultiplier = override ? Number(override.timeMultiplier) : 1;
        const seed = (Math.floor(Math.random() * 0x7fffffff) ^ existingCount) >>> 0;
        const plan = buildAttemptPlan(
          quizRow.questions,
          engineV2
            ? quizRow
            : {
                shuffleQuestions: false,
                shuffleOptions: false,
                questionsPerAttempt: null,
              },
          seed,
        );
        const snapshot: QuizSettingsSnapshot = {
          mode: quizRow.mode,
          timeLimitSeconds: engineV2 ? quizRow.timeLimitSeconds : null,
          availableFrom: quizRow.availableFrom?.toISOString() ?? null,
          availableUntil: quizRow.availableUntil?.toISOString() ?? null,
          dueAt: quizRow.dueAt?.toISOString() ?? null,
          latePolicy: quizRow.latePolicy,
          gradingPolicy: quizRow.gradingPolicy,
          shuffleQuestions: engineV2 && quizRow.shuffleQuestions,
          shuffleOptions: engineV2 && quizRow.shuffleOptions,
          questionsPerAttempt: engineV2 ? quizRow.questionsPerAttempt : null,
          layout: engineV2 ? quizRow.layout : 'all_questions',
          showScore: quizRow.showScore,
          showAnswers: quizRow.showAnswers,
          showExplanations: quizRow.showExplanations,
          integrityMode: engineV2 && integrityOn ? quizRow.integrityMode : 'off',
          maxViolations: quizRow.maxViolations,
          requireFullscreen: engineV2 && integrityOn && quizRow.requireFullscreen,
          hideTimer: quizRow.hideTimer,
          passingScore: quizRow.passingScore,
          maxAttempts: quizRow.maxAttempts,
          timeMultiplier,
          extraAttempts: override?.extraAttempts ?? 0,
          optionOrder: plan.optionOrder,
          engineV2,
        };
        const deadlineAt = engineV2
          ? computeDeadline({
              startedAt: now,
              timeLimitSeconds: snapshot.timeLimitSeconds,
              timeMultiplier,
              availableUntil: override?.availableUntil ?? quizRow.availableUntil,
            })
          : null;

        const created = await this.quizzesRepository.createAttempt(tx, {
          quiz: { connect: { id: quizId } },
          student: { connect: { id: userId } },
          status: 'in_progress',
          answers: [],
          attemptNumber: existingCount + 1,
          startedAt: now,
          deadlineAt,
          seed,
          settingsSnapshot: snapshot as unknown as Prisma.InputJsonValue,
          questionIds: [...plan.questionIds],
          isLate: window === 'late_allowed',
          gradingStatus: 'not_required',
        });
        return { attempt: created, quiz: quizRow, scheduled: deadlineAt };
      });

    if (scheduled) {
      await this.deadlines.schedule(attempt.id, userId, scheduled, now);
      this.metrics.recordQuizAttemptStarted('timed');
    } else if (attempt.createdAt.getTime() >= now.getTime() - 1000) {
      this.metrics.recordQuizAttemptStarted('untimed');
    }
    const count = await this.tenancyContextService.runInUserContext(userId, (tx) =>
      this.attempts.countForStudent(tx, userId, quizId),
    );
    const override = await this.tenancyContextService.runInUserContext(userId, (tx) =>
      this.attempts.findOverride(tx, quizId, userId),
    );
    return toQuizAttemptResponse(
      attempt,
      canStartAttempt(count, quiz.maxAttempts, override?.extraAttempts ?? 0),
      { score: true },
    );
  }

  async getSession(
    userId: string,
    courseId: string,
    quizId: string,
    attemptId: string,
  ): Promise<QuizAttemptSessionResponse> {
    const now = new Date();
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await assertActiveEnrollment(
        tx,
        this.enrollmentsRepository,
        userId,
        courseId,
        this.academyStudentsRepository,
      );
      const { attempt, quiz } = await this.loadOwnAttempt(
        tx,
        userId,
        courseId,
        quizId,
        attemptId,
      );
      if (attempt.status === 'in_progress' && isPastGrace(attempt.deadlineAt, now)) {
        const enrollment = await this.enrollmentsRepository.findByStudentAndCourse(
          tx,
          userId,
          courseId,
        );
        await this.finalizeInTransaction(tx, attempt, quiz, {
          reason: 'timeout',
          now,
          enrollment,
        });
        throw new ConflictException({
          messageKey: 'errors.quiz.attemptExpired',
          details: { attemptId },
        });
      }
      const snapshot = this.snapshotOf(attempt, quiz);
      const questions = this.attemptQuestions(quiz, attempt);
      const override = await this.attempts.findOverride(tx, quizId, userId);
      const used = await this.attempts.countForStudent(tx, userId, quizId);
      return {
        attemptId: attempt.id,
        quizId,
        status: attempt.status,
        attemptNumber: attempt.attemptNumber,
        startedAt: (attempt.startedAt ?? attempt.createdAt).toISOString(),
        deadlineAt: attempt.deadlineAt?.toISOString() ?? null,
        serverNow: now.toISOString(),
        remainingSeconds: remainingSeconds(attempt.deadlineAt, now),
        revision: attempt.answersRevision,
        lastSavedAt: attempt.lastSavedAt?.toISOString() ?? null,
        violationCount: attempt.violationCount,
        settings: settingsToResponse(snapshot),
        questions: questions.map((question) =>
          toSessionQuestion(question, snapshot.optionOrder[question.id]),
        ),
        answers: this.answersOf(attempt).map(toAnswerResponse),
        attemptsUsed: used,
        attemptsAllowed:
          quiz.maxAttempts === null
            ? null
            : quiz.maxAttempts + (override?.extraAttempts ?? 0),
      };
    });
  }

  // ---------------------------------------------------------------------
  // autosave
  // ---------------------------------------------------------------------

  async saveAnswers(
    userId: string,
    courseId: string,
    quizId: string,
    attemptId: string,
    dto: SaveQuizAnswersDto,
  ): Promise<SaveAnswersResponse> {
    const now = new Date();
    const started = process.hrtime.bigint();
    const response = await this.tenancyContextService.runInUserContext(
      userId,
      async (tx) => {
        await assertActiveEnrollment(
          tx,
          this.enrollmentsRepository,
          userId,
          courseId,
          this.academyStudentsRepository,
        );
        const { attempt, quiz } = await this.loadOwnAttempt(
          tx,
          userId,
          courseId,
          quizId,
          attemptId,
        );
        if (attempt.status !== 'in_progress') {
          throw new ConflictException({
            messageKey: 'errors.quiz.attemptAlreadySubmitted',
          });
        }
        if (isPastGrace(attempt.deadlineAt, now)) {
          const enrollment = await this.enrollmentsRepository.findByStudentAndCourse(
            tx,
            userId,
            courseId,
          );
          await this.finalizeInTransaction(tx, attempt, quiz, {
            reason: 'timeout',
            now,
            enrollment,
          });
          throw new ConflictException({
            messageKey: 'errors.quiz.attemptExpired',
            details: { attemptId },
          });
        }
        // Stale revisions are ignored, never applied: the newest server-
        // confirmed answer set wins, and the client learns the revision it
        // must exceed.
        if (dto.revision <= attempt.answersRevision) {
          return {
            attemptId,
            revision: attempt.answersRevision,
            applied: false,
            savedAt: attempt.lastSavedAt?.toISOString() ?? null,
            serverNow: now.toISOString(),
            deadlineAt: attempt.deadlineAt?.toISOString() ?? null,
          };
        }
        const questions = this.attemptQuestions(quiz, attempt);
        const answers = this.normalizeAnswers(dto.answers);
        const problem = validateAnswers(questions, answers);
        if (problem) {
          throw new BadRequestException({ messageKey: ANSWER_VALIDATION_KEYS[problem] });
        }
        await this.attempts.update(tx, attemptId, {
          answers: answers as unknown as Prisma.InputJsonValue,
          answersRevision: dto.revision,
          lastSavedAt: now,
        });
        return {
          attemptId,
          revision: dto.revision,
          applied: true,
          savedAt: now.toISOString(),
          serverNow: now.toISOString(),
          deadlineAt: attempt.deadlineAt?.toISOString() ?? null,
        };
      },
    );
    this.metrics.recordQuizAutosave(Number(process.hrtime.bigint() - started) / 1e6);
    return response;
  }

  // ---------------------------------------------------------------------
  // submit
  // ---------------------------------------------------------------------

  async submit(
    userId: string,
    courseId: string,
    quizId: string,
    attemptId: string,
    dto: SubmitQuizAttemptV2Dto,
  ): Promise<QuizAttemptResponse> {
    const now = new Date();
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const enrollment = await assertActiveEnrollment(
        tx,
        this.enrollmentsRepository,
        userId,
        courseId,
        this.academyStudentsRepository,
      );
      await this.enrollmentsRepository.lockForUpdate(tx, enrollment.id);
      const { attempt, quiz } = await this.loadOwnAttempt(
        tx,
        userId,
        courseId,
        quizId,
        attemptId,
      );
      const override = await this.attempts.findOverride(tx, quizId, userId);
      const disclosure = (finalized: QuizAttempt) =>
        this.disclosureFor(quiz, finalized, override?.extraAttempts ?? 0, now);

      if (attempt.status !== 'in_progress') {
        // Idempotent: a finalised attempt is returned as-is; anything else
        // (invalidated) cannot be submitted.
        if (attempt.status === 'invalidated' || attempt.status === 'not_started') {
          throw new BadRequestException({
            messageKey: 'errors.quiz.attemptAlreadySubmitted',
          });
        }
        const used = await this.attempts.countForStudent(tx, userId, quizId);
        return toQuizAttemptResponse(
          attempt,
          canStartAttempt(used, quiz.maxAttempts, override?.extraAttempts ?? 0),
          await disclosure(attempt),
        );
      }
      if (isPastGrace(attempt.deadlineAt, now)) {
        await this.finalizeInTransaction(tx, attempt, quiz, {
          reason: 'timeout',
          now,
          enrollment,
        });
        throw new ConflictException({
          messageKey: 'errors.quiz.attemptExpired',
          details: { attemptId },
        });
      }

      const snapshot = this.snapshotOf(attempt, quiz);
      const questions = this.attemptQuestions(quiz, attempt);
      let answers = this.answersOf(attempt);
      if (dto.answers) {
        if (dto.revision !== undefined && dto.revision < attempt.answersRevision) {
          // A stale final payload never overwrites newer autosaved answers.
        } else {
          const submitted = this.normalizeAnswers(dto.answers);
          const problem = validateAnswers(questions, submitted);
          if (problem)
            throw new BadRequestException({
              messageKey: ANSWER_VALIDATION_KEYS[problem],
            });
          answers = submitted;
        }
      }
      // Legacy behaviour (engine v2 off): every question must be answered.
      if (!snapshot.engineV2) {
        const answered = new Set(
          answers
            .filter(
              (a) => (a.selectedOptionIds?.length ?? 0) > 0 || (a.text ?? '').trim(),
            )
            .map((a) => a.questionId),
        );
        if (questions.some((q) => !answered.has(q.id))) {
          throw new BadRequestException({ messageKey: 'errors.quiz.incompleteAnswers' });
        }
      }
      const outcome = await this.finalizeInTransaction(tx, attempt, quiz, {
        reason: 'submit',
        now,
        enrollment,
        answers,
        revision: dto.revision,
      });
      const used = await this.attempts.countForStudent(tx, userId, quizId);
      return toQuizAttemptResponse(
        outcome.attempt,
        canStartAttempt(used, quiz.maxAttempts, override?.extraAttempts ?? 0),
        await disclosure(outcome.attempt),
      );
    });
  }

  // ---------------------------------------------------------------------
  // integrity events
  // ---------------------------------------------------------------------

  async recordEvents(
    userId: string,
    courseId: string,
    quizId: string,
    attemptId: string,
    dto: RecordQuizAttemptEventsDto,
  ): Promise<RecordEventsResponse> {
    const now = new Date();
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const enrollment = await assertActiveEnrollment(
        tx,
        this.enrollmentsRepository,
        userId,
        courseId,
        this.academyStudentsRepository,
      );
      const { attempt, quiz } = await this.loadOwnAttempt(
        tx,
        userId,
        courseId,
        quizId,
        attemptId,
      );
      const snapshot = this.snapshotOf(attempt, quiz);
      if (attempt.status !== 'in_progress') {
        return {
          attemptId,
          recorded: 0,
          violationCount: attempt.violationCount,
          maxViolations: snapshot.maxViolations,
          action: 'none',
          status: attempt.status,
        };
      }
      const state = await this.attempts.findIntegrityState(tx, attemptId);
      const decision = decideIntegrity({
        mode: snapshot.integrityMode,
        maxViolations: snapshot.maxViolations,
        violationCount: attempt.violationCount,
        startedAt: attempt.startedAt ?? attempt.createdAt,
        now,
        lastCountedAt: state.lastCountedAt,
        lastHiddenAt: state.lastHiddenAt,
        events: dto.events.map((event) => ({
          type: event.type,
          clientAt: event.clientAt ? new Date(event.clientAt) : null,
          payload: event.payload ?? null,
        })),
      });
      const recorded = await this.attempts.createEvents(
        tx,
        attemptId,
        dto.events.map((event, index) => ({
          type: event.type,
          counted: decision.counted[index] ?? false,
          clientAt: event.clientAt ? new Date(event.clientAt) : null,
          serverAt: now,
          payload: (event.payload as Prisma.InputJsonValue | undefined) ?? null,
        })),
      );
      for (const event of dto.events) this.metrics.recordIntegrityEvent(event.type);
      let status: QuizAttempt['status'] = attempt.status;
      if (
        decision.violationCount !== attempt.violationCount ||
        decision.flagged !== attempt.integrityFlagged
      ) {
        await this.attempts.update(tx, attemptId, {
          violationCount: decision.violationCount,
          integrityFlagged: attempt.integrityFlagged || decision.flagged,
        });
      }
      if (decision.action === 'auto_submit') {
        const fresh = await this.attempts.findById(tx, attemptId);
        if (fresh && fresh.status === 'in_progress') {
          const outcome = await this.finalizeInTransaction(tx, fresh, quiz, {
            reason: 'integrity',
            now,
            enrollment,
          });
          status = outcome.attempt.status;
        }
      }
      return {
        attemptId,
        recorded,
        violationCount: decision.violationCount,
        maxViolations: snapshot.maxViolations,
        action: decision.action,
        status,
      };
    });
  }

  // ---------------------------------------------------------------------
  // results
  // ---------------------------------------------------------------------

  async getResults(
    userId: string,
    courseId: string,
    quizId: string,
    attemptId: string,
  ): Promise<QuizAttemptResultsResponse> {
    const now = new Date();
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await assertActiveEnrollment(
        tx,
        this.enrollmentsRepository,
        userId,
        courseId,
        this.academyStudentsRepository,
      );
      const { attempt, quiz } = await this.loadOwnAttempt(
        tx,
        userId,
        courseId,
        quizId,
        attemptId,
      );
      if (attempt.status === 'in_progress' && isPastGrace(attempt.deadlineAt, now)) {
        const enrollment = await this.enrollmentsRepository.findByStudentAndCourse(
          tx,
          userId,
          courseId,
        );
        await this.finalizeInTransaction(tx, attempt, quiz, {
          reason: 'timeout',
          now,
          enrollment,
        });
      }
      const current = (await this.attempts.findById(tx, attemptId)) ?? attempt;
      const override = await this.attempts.findOverride(tx, quizId, userId);
      const extra = override?.extraAttempts ?? 0;
      const disclosure = await this.disclosureFor(quiz, current, extra, now);
      const questions = this.attemptQuestions(quiz, current);
      const answers = this.answersOf(current);
      const answerByQuestion = new Map(
        answers.map((answer) => [answer.questionId, answer]),
      );
      const finalized =
        current.status !== 'in_progress' && current.status !== 'not_started';
      const score = finalized
        ? scoreAttempt(questions, answers, this.manualGradesOf(current))
        : null;
      const scoreByQuestion = new Map(
        score?.perQuestion.map((row) => [row.questionId, row]) ?? [],
      );
      const used = await this.attempts.countForStudent(tx, userId, quizId);
      const result = await this.attempts.findResult(tx, quizId, userId);
      return {
        attemptId: current.id,
        quizId,
        status: current.status,
        attemptNumber: current.attemptNumber,
        submittedAt: current.submittedAt?.toISOString() ?? null,
        autoSubmitted: current.autoSubmitted,
        autoSubmittedReason: current.autoSubmittedReason,
        isLate: current.isLate,
        gradingStatus: current.gradingStatus,
        disclosure,
        ...(disclosure.score
          ? {
              score: current.score !== null ? Number(current.score) : null,
              passed: current.passed,
              pointsEarned:
                current.pointsEarned !== null ? Number(current.pointsEarned) : undefined,
              pointsTotal:
                current.pointsTotal !== null ? Number(current.pointsTotal) : undefined,
              effectiveScore:
                result?.effectiveScore !== null && result?.effectiveScore !== undefined
                  ? Number(result.effectiveScore)
                  : null,
              effectivePassed: result?.passed ?? false,
            }
          : {}),
        passingScore: quiz.passingScore,
        questions: questions.map((question) =>
          toResultQuestion(
            question,
            answerByQuestion.get(question.id),
            scoreByQuestion.get(question.id),
            disclosure,
          ),
        ),
        canRetry:
          canStartAttempt(used, quiz.maxAttempts, extra) &&
          current.status !== 'in_progress',
        attemptsUsed: used,
        attemptsAllowed: quiz.maxAttempts === null ? null : quiz.maxAttempts + extra,
      };
    });
  }

  // ---------------------------------------------------------------------
  // auto-submit (job + sweep)
  // ---------------------------------------------------------------------

  /** Finalises one overdue attempt under its student's own context. Idempotent. */
  async finalizeOverdueAttempt(
    attemptId: string,
    studentId: string,
  ): Promise<'finalized' | 'skipped'> {
    const now = new Date();
    return this.tenancyContextService.runInUserContext(studentId, async (tx) => {
      const attempt = await this.attempts.findById(tx, attemptId);
      if (!attempt || attempt.studentId !== studentId || attempt.status !== 'in_progress')
        return 'skipped';
      if (!isPastGrace(attempt.deadlineAt, now)) return 'skipped';
      const quiz = await this.quizzesRepository.findByIdWithCorrectAnswers(
        tx,
        attempt.quizId,
      );
      if (!quiz) return 'skipped';
      const enrollment = await this.enrollmentsRepository.findByStudentAndCourse(
        tx,
        studentId,
        quiz.courseId,
      );
      await this.finalizeInTransaction(tx, attempt, quiz, {
        reason: 'timeout',
        now,
        enrollment,
      });
      return 'finalized';
    });
  }

  /** The sweep: catches attempts whose delayed job never fired. */
  async finalizeOverdue(limit = 200): Promise<number> {
    const due = await this.attempts.findDueAttempts(limit);
    let finalized = 0;
    for (const row of due) {
      try {
        const outcome = await this.finalizeOverdueAttempt(row.id, row.student_id);
        if (outcome === 'finalized') {
          finalized += 1;
          this.metrics.recordQuizDeadlineSweepFinalized();
        }
      } catch (error) {
        this.logger.warn(
          {
            attemptId: row.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'Sweep could not finalise an overdue quiz attempt; it will be retried next run.',
        );
      }
    }
    return finalized;
  }

  // ---------------------------------------------------------------------
  // shared: finalisation, results, completion
  // ---------------------------------------------------------------------

  /**
   * Grades and closes an attempt inside the caller's transaction. Uses a
   * conditional update so two racing finalisers (learner submit vs the
   * deadline job) cannot both apply: the loser observes zero rows and
   * returns the winner's row.
   */
  async finalizeInTransaction(
    tx: Prisma.TransactionClient,
    attempt: QuizAttempt,
    quiz: QuizWithQuestions,
    input: {
      readonly reason: FinalizeReason;
      readonly now: Date;
      readonly enrollment: {
        id: string;
        studentId: string;
        courseId: string;
        academyId: string;
        status: string;
      } | null;
      readonly answers?: readonly AttemptAnswer[];
      readonly revision?: number;
      readonly manualGrades?: Record<string, number> | null;
    },
  ): Promise<FinalizeOutcome> {
    const questions = this.attemptQuestions(quiz, attempt);
    const answers = input.answers ?? this.answersOf(attempt);
    const manualGrades = input.manualGrades ?? this.manualGradesOf(attempt);
    const score = scoreAttempt(questions, answers, manualGrades);
    const passed = isPassing(score.score, quiz.passingScore);
    const status: QuizAttempt['status'] = score.pendingManual
      ? 'submitted'
      : passed
        ? 'passed'
        : 'failed';
    const changed = await this.attempts.updateIfInProgress(tx, attempt.id, {
      status,
      answers: answers as unknown as Prisma.InputJsonValue,
      ...(input.revision !== undefined && input.revision > attempt.answersRevision
        ? { answersRevision: input.revision }
        : {}),
      score: score.score,
      passed: score.pendingManual ? null : passed,
      pointsEarned: score.pointsEarned,
      pointsTotal: score.pointsTotal,
      submittedAt: input.now,
      autoSubmitted: input.reason !== 'submit',
      autoSubmittedReason: input.reason === 'submit' ? null : input.reason,
      gradingStatus: score.pendingManual
        ? 'pending'
        : attempt.gradingStatus === 'pending'
          ? 'graded'
          : 'not_required',
      lastSavedAt: input.now,
    });
    const fresh = (await this.attempts.findById(tx, attempt.id)) ?? attempt;
    if (changed === 0) {
      return { attempt: fresh, pendingGrading: fresh.gradingStatus === 'pending' };
    }
    this.metrics.recordQuizAttemptSubmitted(input.reason);
    await this.recomputeResultAndCompletion(
      tx,
      quiz,
      fresh.studentId,
      input.enrollment,
      input.now,
    );
    return { attempt: fresh, pendingGrading: score.pendingManual };
  }

  /** Re-aggregates the quiz result by policy and re-evaluates course completion. */
  async recomputeResultAndCompletion(
    tx: Prisma.TransactionClient,
    quiz: Pick<Quiz, 'id' | 'courseId' | 'gradingPolicy' | 'passingScore'>,
    studentId: string,
    enrollment: {
      id: string;
      studentId: string;
      courseId: string;
      academyId: string;
      status: string;
    } | null,
    now: Date,
  ): Promise<void> {
    const rows = await this.attempts.findFinalizedForStudent(tx, studentId, quiz.id);
    const summaries: FinalizedAttemptSummary[] = rows.map((row) => ({
      id: row.id,
      attemptNumber: row.attemptNumber,
      score: row.score !== null ? Number(row.score) : null,
      passed: row.passed,
      submittedAt: row.submittedAt ?? row.createdAt,
      pendingGrading: row.gradingStatus === 'pending',
    }));
    const aggregate = aggregateResult(quiz.gradingPolicy, summaries, quiz.passingScore);
    await this.attempts.upsertResult(tx, quiz.id, studentId, aggregate);
    if (enrollment) {
      await this.completion.recompute(tx, enrollment, now);
    }
  }

  // ---------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------

  private async loadOwnAttempt(
    tx: Prisma.TransactionClient,
    userId: string,
    courseId: string,
    quizId: string,
    attemptId: string,
  ): Promise<{ attempt: QuizAttempt; quiz: QuizWithQuestions }> {
    const attempt = await this.attempts.findById(tx, attemptId);
    if (!attempt || attempt.studentId !== userId || attempt.quizId !== quizId) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    const quiz = await this.quizzesRepository.findByIdWithCorrectAnswers(tx, quizId);
    if (!quiz || quiz.courseId !== courseId) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    return { attempt, quiz };
  }

  /** The engine-shaped questions of THIS attempt (its own ordered subset). */
  attemptQuestions(quiz: QuizWithQuestions, attempt: QuizAttempt): EngineQuestion[] {
    const engine = quiz.questions.map(toEngineQuestion);
    const ids = Array.isArray(attempt.questionIds)
      ? (attempt.questionIds as string[])
      : null;
    if (!ids || ids.length === 0) {
      return [...engine].sort((a, b) => a.order - b.order);
    }
    const byId = new Map(engine.map((question) => [question.id, question]));
    return ids.map((id) => byId.get(id)).filter((q): q is EngineQuestion => Boolean(q));
  }

  snapshotOf(attempt: QuizAttempt, quiz: Quiz): QuizSettingsSnapshot {
    const stored =
      attempt.settingsSnapshot as unknown as Partial<QuizSettingsSnapshot> | null;
    // Attempts started before Phase 3 have no snapshot: they behave as
    // pre-Phase-3 attempts (no timer, nothing shuffled, integrity off).
    return {
      mode: stored?.mode ?? quiz.mode,
      timeLimitSeconds: stored?.timeLimitSeconds ?? null,
      availableFrom: stored?.availableFrom ?? null,
      availableUntil: stored?.availableUntil ?? null,
      dueAt: stored?.dueAt ?? null,
      latePolicy: stored?.latePolicy ?? quiz.latePolicy,
      gradingPolicy: stored?.gradingPolicy ?? quiz.gradingPolicy,
      shuffleQuestions: stored?.shuffleQuestions ?? false,
      shuffleOptions: stored?.shuffleOptions ?? false,
      questionsPerAttempt: stored?.questionsPerAttempt ?? null,
      layout: stored?.layout ?? 'all_questions',
      showScore: stored?.showScore ?? quiz.showScore,
      showAnswers: stored?.showAnswers ?? quiz.showAnswers,
      showExplanations: stored?.showExplanations ?? quiz.showExplanations,
      integrityMode: stored?.integrityMode ?? 'off',
      maxViolations: stored?.maxViolations ?? quiz.maxViolations,
      requireFullscreen: stored?.requireFullscreen ?? false,
      hideTimer: stored?.hideTimer ?? quiz.hideTimer,
      passingScore: stored?.passingScore ?? quiz.passingScore,
      maxAttempts: stored?.maxAttempts ?? quiz.maxAttempts,
      timeMultiplier: stored?.timeMultiplier ?? 1,
      extraAttempts: stored?.extraAttempts ?? 0,
      optionOrder: stored?.optionOrder ?? {},
      engineV2: stored?.engineV2 ?? false,
    };
  }

  answersOf(attempt: QuizAttempt): AttemptAnswer[] {
    const raw = attempt.answers;
    if (!Array.isArray(raw)) return [];
    return this.normalizeAnswers(raw as unknown as readonly Partial<AttemptAnswer>[]);
  }

  manualGradesOf(attempt: QuizAttempt): Record<string, number> | null {
    const raw = attempt.manualGrades;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    }
    return out;
  }

  private normalizeAnswers(input: readonly Partial<AttemptAnswer>[]): AttemptAnswer[] {
    return input
      .filter(
        (answer): answer is Partial<AttemptAnswer> & { questionId: string } =>
          typeof answer?.questionId === 'string',
      )
      .map((answer) => ({
        questionId: answer.questionId,
        ...(Array.isArray(answer.selectedOptionIds)
          ? {
              selectedOptionIds: answer.selectedOptionIds.filter(
                (id): id is string => typeof id === 'string',
              ),
            }
          : {}),
        ...(typeof answer.text === 'string' ? { text: answer.text } : {}),
      }));
  }

  private async disclosureFor(
    quiz: Quiz,
    attempt: QuizAttempt,
    extraAttempts: number,
    now: Date,
  ): Promise<Disclosure> {
    const snapshot = this.snapshotOf(attempt, quiz);
    const finalized =
      attempt.status !== 'in_progress' && attempt.status !== 'not_started';
    return resolveDisclosure({
      showScore: snapshot.showScore,
      showAnswers: snapshot.showAnswers,
      showExplanations: snapshot.showExplanations,
      now,
      dueAt: quiz.dueAt,
      availableUntil: quiz.availableUntil,
      attemptsUsed: attempt.attemptNumber,
      maxAttempts: quiz.maxAttempts === null ? null : quiz.maxAttempts + extraAttempts,
      attemptFinalized: finalized,
    });
  }
}

export function toEngineQuestion(
  question: QuizQuestion & { options: QuizQuestionOption[] },
): EngineQuestion {
  return {
    id: question.id,
    type: question.type,
    prompt: question.prompt,
    points: question.points,
    order: question.order,
    explanation: question.explanation,
    relatedLessonId: question.relatedLessonId,
    acceptedAnswers: Array.isArray(question.acceptedAnswers)
      ? (question.acceptedAnswers as unknown[]).filter(
          (a): a is string => typeof a === 'string',
        )
      : null,
    options: question.options.map((option) => ({
      id: option.id,
      label: option.label,
      isCorrect: option.isCorrect,
    })),
  };
}
