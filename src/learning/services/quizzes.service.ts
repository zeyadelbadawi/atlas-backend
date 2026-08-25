/**
 * QuizzesService — matches `QuizService` (atlas frontend) exactly. Quiz
 * authoring stays out of scope (frontend's own doc comment) — this
 * service only reads published quizzes and manages the current student's
 * attempts.
 *
 * `is_correct` never reaches a pre-submission response — `getQuiz` builds
 * its response through `toQuizResponse`/`toQuizQuestionResponse`, which
 * structurally cannot read that column (master plan §5.4/§9/§16, §18
 * scenario 7). Scoring (`submitAttempt`) reads the same quiz through a
 * separate, correctness-including repository method that is never passed
 * to a response DTO. The actual scoring/coverage logic lives in
 * `quiz-scoring.util.ts` as pure functions, unit-tested there directly.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { EnrollmentsRepository } from '../repositories/enrollments.repository';
import { CourseInstructorsRepository } from '../../course/repositories/course-instructors.repository';
import { QuizzesRepository } from '../repositories/quizzes.repository';
import { toQuizResponse } from '../dto/quiz.contract';
import type { QuizResponse } from '../dto/quiz.contract';
import { toQuizAttemptResponse } from '../dto/quiz-attempt.contract';
import type { QuizAttemptResponse } from '../dto/quiz-attempt.contract';
import type { SubmitQuizAttemptDto } from '../dto/submit-quiz-attempt.dto';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { assertActiveEnrollment, assertCourseReadAccess } from './learning-access.util';
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
    private readonly quizzesRepository: QuizzesRepository,
  ) {}

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
}
