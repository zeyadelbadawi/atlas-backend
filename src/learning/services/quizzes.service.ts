/**
 * QuizzesService — matches `QuizService` (atlas frontend) exactly for the
 * student-facing surface (`getQuizzes`/`getQuiz`/attempts). Quiz
 * authoring (Phase 4, P24) is a separate, structurally distinct surface
 * — `createQuiz`/`updateQuiz`/`deleteQuiz`/`getQuizzesForAuthoring`/
 * `getQuizForAuthoring` — gated by `assertCanAuthorCourseContent`
 * (narrower than `assertCourseReadAccess`: an enrolled student can read,
 * never author) and built through `quiz-authoring.contract.ts`'s own
 * mappers, never `quiz.contract.ts`'s.
 *
 * `is_correct` never reaches a pre-submission STUDENT response — `getQuiz`
 * builds its response through `toQuizResponse`/`toQuizQuestionResponse`,
 * which structurally cannot read that column (master plan §5.4/§9/§16,
 * §18 scenario 7) — completely unmodified by this phase. Scoring
 * (`submitAttempt`) reads the same quiz through a separate,
 * correctness-including repository method that is never passed to a
 * response DTO. The actual scoring/coverage logic lives in
 * `quiz-scoring.util.ts` as pure functions, unit-tested there directly —
 * also completely unmodified by this phase.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { EnrollmentsRepository } from '../repositories/enrollments.repository';
import { CourseInstructorsRepository } from '../../course/repositories/course-instructors.repository';
import { CoursesRepository } from '../../course/repositories/courses.repository';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import { AcademiesRepository } from '../../academy/repositories/academies.repository';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { QuizzesRepository } from '../repositories/quizzes.repository';
import { toQuizResponse } from '../dto/quiz.contract';
import type { QuizResponse } from '../dto/quiz.contract';
import { toQuizAuthoringResponse } from '../dto/quiz-authoring.contract';
import type { QuizAuthoringResponse } from '../dto/quiz-authoring.contract';
import { toQuizAttemptResponse } from '../dto/quiz-attempt.contract';
import type { QuizAttemptResponse } from '../dto/quiz-attempt.contract';
import type { SubmitQuizAttemptDto } from '../dto/submit-quiz-attempt.dto';
import type { CreateQuizDto } from '../dto/create-quiz.dto';
import type { UpdateQuizDto } from '../dto/update-quiz.dto';
import type { QuizQuestionInputDto } from '../dto/quiz-question-input.dto';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import {
  assertActiveEnrollment,
  assertCanAuthorCourseContent,
  assertCourseReadAccess,
} from './learning-access.util';
import {
  canStartAnotherAttempt,
  isAttemptPassing,
  isExactQuestionCoverage,
  scoreQuizAttempt,
} from './quiz-scoring.util';

@Injectable()
export class QuizzesService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly enrollmentsRepository: EnrollmentsRepository,
    private readonly courseInstructorsRepository: CourseInstructorsRepository,
    private readonly coursesRepository: CoursesRepository,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly academiesRepository: AcademiesRepository,
    private readonly quizzesRepository: QuizzesRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

  /** See `AssignmentsService.resolveAuditAttribution`'s identical doc comment — same shape, same reasoning, this module's own authoring surface. */
  private async resolveAuditAttribution(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<{ organizationId: string | undefined; role: string }> {
    const [organizationId, membership] = await Promise.all([
      this.academiesRepository.resolveOrganizationId(academyId),
      this.academyMembersRepository.findForUserInAcademy(tx, academyId, userId),
    ]);
    return {
      organizationId: organizationId ?? undefined,
      role: membership?.role ?? 'instructor',
    };
  }

  async getQuizzes(
    userId: string,
    courseId: string,
  ): Promise<PaginatedResult<QuizResponse>> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await assertCourseReadAccess(
        tx,
        this.enrollmentsRepository,
        this.courseInstructorsRepository,
        userId,
        courseId,
      );
      const quizzes = await this.quizzesRepository.findManyPublishedForCourse(
        tx,
        courseId,
      );
      const items = quizzes.map((quiz) => toQuizResponse(quiz, quiz._count.questions));
      return {
        items,
        pagination: buildPaginationMeta(1, Math.max(items.length, 1), items.length),
      };
    });
  }

  async getQuiz(userId: string, courseId: string, quizId: string): Promise<QuizResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await assertCourseReadAccess(
        tx,
        this.enrollmentsRepository,
        this.courseInstructorsRepository,
        userId,
        courseId,
      );
      const quiz = await this.quizzesRepository.findPublishedByIdWithQuestions(
        tx,
        courseId,
        quizId,
      );
      if (!quiz) throw new NotFoundException({ messageKey: 'errors.notFound' });
      return toQuizResponse(quiz, quiz.questions.length);
    });
  }

  async getAttempts(
    userId: string,
    courseId: string,
    quizId: string,
  ): Promise<PaginatedResult<QuizAttemptResponse>> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await assertActiveEnrollment(tx, this.enrollmentsRepository, userId, courseId);
      const quiz = await this.quizzesRepository.findPublishedById(tx, courseId, quizId);
      if (!quiz) throw new NotFoundException({ messageKey: 'errors.notFound' });

      const { items, totalItems } = await this.quizzesRepository.findAttemptsForStudent(
        tx,
        userId,
        quizId,
      );
      const canRetry = canStartAnotherAttempt(totalItems, quiz.maxAttempts);

      return {
        items: items.map((attempt) => toQuizAttemptResponse(attempt, canRetry)),
        pagination: buildPaginationMeta(1, Math.max(items.length, 1), totalItems),
      };
    });
  }

  async startAttempt(
    userId: string,
    courseId: string,
    quizId: string,
  ): Promise<QuizAttemptResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await assertActiveEnrollment(tx, this.enrollmentsRepository, userId, courseId);
      const quiz = await this.quizzesRepository.findPublishedById(tx, courseId, quizId);
      if (!quiz) throw new NotFoundException({ messageKey: 'errors.notFound' });

      const existingCount = await this.quizzesRepository.countAttemptsForStudent(
        tx,
        userId,
        quizId,
      );
      if (!canStartAnotherAttempt(existingCount, quiz.maxAttempts)) {
        throw new ForbiddenException({ messageKey: 'errors.quiz.maxAttemptsReached' });
      }

      const attempt = await this.quizzesRepository.createAttempt(tx, {
        quiz: { connect: { id: quizId } },
        student: { connect: { id: userId } },
        status: 'in_progress',
        answers: [],
        attemptNumber: existingCount + 1,
      });

      const canRetry = canStartAnotherAttempt(existingCount + 1, quiz.maxAttempts);
      return toQuizAttemptResponse(attempt, canRetry);
    });
  }

  async submitAttempt(
    userId: string,
    courseId: string,
    quizId: string,
    attemptId: string,
    payload: SubmitQuizAttemptDto,
  ): Promise<QuizAttemptResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await assertActiveEnrollment(tx, this.enrollmentsRepository, userId, courseId);

      const attempt = await this.quizzesRepository.findAttemptById(tx, attemptId);
      if (!attempt || attempt.studentId !== userId || attempt.quizId !== quizId) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }
      if (attempt.status !== 'in_progress') {
        throw new BadRequestException({
          messageKey: 'errors.quiz.attemptAlreadySubmitted',
        });
      }

      const quiz = await this.quizzesRepository.findByIdWithCorrectAnswers(tx, quizId);
      if (!quiz || quiz.courseId !== courseId) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }

      if (!isExactQuestionCoverage(quiz.questions, payload.answers)) {
        throw new BadRequestException({ messageKey: 'errors.quiz.incompleteAnswers' });
      }

      const { score } = scoreQuizAttempt(quiz.questions, payload.answers);
      const passed = isAttemptPassing(score, quiz.passingScore);

      const updated = await this.quizzesRepository.updateAttempt(tx, attemptId, {
        status: passed ? 'passed' : 'failed',
        answers: payload.answers.map((answer) => ({
          questionId: answer.questionId,
          selectedOptionIds: answer.selectedOptionIds,
        })),
        score,
        passed,
        submittedAt: new Date(),
      });

      const totalAttempts = await this.quizzesRepository.countAttemptsForStudent(
        tx,
        userId,
        quizId,
      );
      const canRetry = canStartAnotherAttempt(totalAttempts, quiz.maxAttempts);

      return toQuizAttemptResponse(updated, canRetry);
    });
  }

  // -------------------------------------------------------------------
  // Phase 4 (P24) — authoring.
  // -------------------------------------------------------------------

  async getQuizzesForAuthoring(
    userId: string,
    courseId: string,
  ): Promise<PaginatedResult<QuizResponse>> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await assertCanAuthorCourseContent(
        tx,
        this.coursesRepository,
        this.academyMembersRepository,
        this.courseInstructorsRepository,
        userId,
        courseId,
      );
      const quizzes = await this.quizzesRepository.findManyForCourseAnyStatus(
        tx,
        courseId,
      );
      const items = quizzes.map((quiz) => toQuizResponse(quiz, quiz._count.questions));
      return {
        items,
        pagination: buildPaginationMeta(1, Math.max(items.length, 1), items.length),
      };
    });
  }

  async getQuizForAuthoring(
    userId: string,
    courseId: string,
    quizId: string,
  ): Promise<QuizAuthoringResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await assertCanAuthorCourseContent(
        tx,
        this.coursesRepository,
        this.academyMembersRepository,
        this.courseInstructorsRepository,
        userId,
        courseId,
      );
      const quiz = await this.quizzesRepository.findAnyByIdWithQuestions(
        tx,
        courseId,
        quizId,
      );
      if (!quiz) throw new NotFoundException({ messageKey: 'errors.notFound' });
      return toQuizAuthoringResponse(quiz);
    });
  }

  async createQuiz(
    userId: string,
    courseId: string,
    payload: CreateQuizDto,
  ): Promise<QuizAuthoringResponse> {
    this.assertValidQuestions(payload.questions);

    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const academyId = await assertCanAuthorCourseContent(
        tx,
        this.coursesRepository,
        this.academyMembersRepository,
        this.courseInstructorsRepository,
        userId,
        courseId,
      );
      const quiz = await this.quizzesRepository.create(tx, courseId, payload);

      const { organizationId, role } = await this.resolveAuditAttribution(
        tx,
        academyId,
        userId,
      );
      await this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        organizationId,
        academyId,
        role,
        action: 'quiz.created',
        targetType: 'quiz',
        targetId: quiz.id,
        targetLabel: quiz.title,
        context: { courseId },
      });

      return toQuizAuthoringResponse(quiz);
    });
  }

  /** `questions`, when present, REPLACES the quiz's entire question/option set (see `UpdateQuizDto`/`QuizzesRepository.replaceQuestions`'s own doc comments) — omit it entirely to update only title/description/status/passingScore/maxAttempts. */
  async updateQuiz(
    userId: string,
    courseId: string,
    quizId: string,
    payload: UpdateQuizDto,
  ): Promise<QuizAuthoringResponse> {
    if (payload.questions) {
      this.assertValidQuestions(payload.questions);
    }

    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const academyId = await assertCanAuthorCourseContent(
        tx,
        this.coursesRepository,
        this.academyMembersRepository,
        this.courseInstructorsRepository,
        userId,
        courseId,
      );
      const existing = await this.quizzesRepository.findAnyByIdWithQuestions(
        tx,
        courseId,
        quizId,
      );
      if (!existing) throw new NotFoundException({ messageKey: 'errors.notFound' });

      await this.quizzesRepository.update(tx, quizId, {
        title: payload.title,
        description: payload.description,
        sectionId: payload.sectionId,
        status: payload.status,
        passingScore: payload.passingScore,
        maxAttempts: payload.maxAttempts,
      });

      if (payload.questions) {
        await this.quizzesRepository.replaceQuestions(tx, quizId, payload.questions);
      }

      const updated = await this.quizzesRepository.findAnyByIdWithQuestions(
        tx,
        courseId,
        quizId,
      );

      const { organizationId, role } = await this.resolveAuditAttribution(
        tx,
        academyId,
        userId,
      );
      await this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        organizationId,
        academyId,
        role,
        action: 'quiz.updated',
        targetType: 'quiz',
        targetId: quizId,
        targetLabel: updated!.title,
        context: { courseId },
      });

      return toQuizAuthoringResponse(updated!);
    });
  }

  async deleteQuiz(userId: string, courseId: string, quizId: string): Promise<void> {
    await this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const academyId = await assertCanAuthorCourseContent(
        tx,
        this.coursesRepository,
        this.academyMembersRepository,
        this.courseInstructorsRepository,
        userId,
        courseId,
      );
      const existing = await this.quizzesRepository.findAnyByIdWithQuestions(
        tx,
        courseId,
        quizId,
      );
      if (!existing) throw new NotFoundException({ messageKey: 'errors.notFound' });

      await this.quizzesRepository.delete(tx, quizId);

      const { organizationId, role } = await this.resolveAuditAttribution(
        tx,
        academyId,
        userId,
      );
      await this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        organizationId,
        academyId,
        role,
        action: 'quiz.deleted',
        targetType: 'quiz',
        targetId: quizId,
        targetLabel: existing.title,
        context: { courseId },
      });
    });
  }

  /**
   * Server-side re-enforcement of the exact shape rules
   * `quiz-scoring.util.ts`'s scoring engine actually depends on — never
   * trust the client-side authoring form alone, the same discipline
   * `AssignmentsService.submitAssignment`'s own doc comment already
   * documents for its own cross-field check:
   *   - `true_false` — exactly two options, exactly one correct.
   *   - `single_choice` — exactly one correct option.
   *   - `multiple_choice` — at least one correct option.
   * A malformed question (e.g. zero correct options) would still "work"
   * mechanically — `scoreQuizAttempt`'s set-equality check just makes it
   * unanswerable-correctly by design — but authoring one is always a
   * real mistake, never a legitimate quiz, so it's rejected outright
   * rather than silently persisted.
   */
  private assertValidQuestions(questions: readonly QuizQuestionInputDto[]): void {
    for (const question of questions) {
      const correctCount = question.options.filter((o) => o.isCorrect).length;

      if (question.type === 'true_false' && question.options.length !== 2) {
        throw new BadRequestException({
          messageKey: 'errors.quiz.trueFalseRequiresTwoOptions',
        });
      }
      if (
        (question.type === 'true_false' || question.type === 'single_choice') &&
        correctCount !== 1
      ) {
        throw new BadRequestException({
          messageKey: 'errors.quiz.singleChoiceRequiresOneCorrectOption',
        });
      }
      if (question.type === 'multiple_choice' && correctCount < 1) {
        throw new BadRequestException({
          messageKey: 'errors.quiz.multipleChoiceRequiresOneCorrectOption',
        });
      }
    }
  }
}
