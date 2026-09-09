/**
 * StudentResultsRepository — the reads behind `GET /learning/results`
 * (Phase 9, "My Results").
 *
 * Every method runs under `TenancyContextService.runInUserContext(studentId)`
 * and additionally filters on `studentId` explicitly. That redundancy is
 * deliberate and is the whole security story for this surface: the
 * `quiz_attempts_self_select` and `assignment_submissions_self_select` RLS
 * policies (P6) already restrict these tables to the acting student at the
 * database level, so a bug in the `where` clauses below could not leak
 * another student's results — and equally, a mistake in the policies could
 * not leak them past the `where` clauses. Neither layer is trusted alone,
 * matching this codebase's standing rule.
 *
 * Nothing here reads a quiz question's `isCorrect`, a peer's attempt, or
 * any instructor-only field — the response contract has no place to put
 * them.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

export type StudentQuizAttemptRow = {
  id: string;
  quizId: string;
  attemptNumber: number;
  score: Prisma.Decimal | null;
  passed: boolean | null;
  submittedAt: Date | null;
  quiz: { id: string; title: string; courseId: string; passingScore: number | null };
};

export type StudentSubmissionRow = {
  id: string;
  assignmentId: string;
  status: string;
  gradingStatus: string;
  score: Prisma.Decimal | null;
  submittedAt: Date | null;
  gradedAt: Date | null;
  feedback: string | null;
  assignment: { id: string; title: string; courseId: string };
};

@Injectable()
export class StudentResultsRepository {
  /**
   * Every FINISHED attempt this student has made, newest first — the
   * three terminal values of `QuizAttemptStatus` (`submitted`, and the
   * scored `passed`/`failed`). `not_started`/`in_progress` are excluded:
   * an unfinished attempt has no result to report, and including it would
   * put a `null` score on a "results" page as though the student had
   * scored nothing.
   */
  findQuizAttemptsForStudent(
    tx: Prisma.TransactionClient,
    studentId: string,
  ): Promise<StudentQuizAttemptRow[]> {
    return tx.quizAttempt.findMany({
      where: { studentId, status: { in: ['submitted', 'passed', 'failed'] } },
      select: {
        id: true,
        quizId: true,
        attemptNumber: true,
        score: true,
        passed: true,
        submittedAt: true,
        quiz: {
          select: { id: true, title: true, courseId: true, passingScore: true },
        },
      },
      orderBy: [{ submittedAt: 'desc' }, { attemptNumber: 'desc' }],
    }) as unknown as Promise<StudentQuizAttemptRow[]>;
  }

  /** Every submission this student has made. `draft` rows are excluded for the same reason unfinished attempts are. */
  findSubmissionsForStudent(
    tx: Prisma.TransactionClient,
    studentId: string,
  ): Promise<StudentSubmissionRow[]> {
    return tx.assignmentSubmission.findMany({
      where: { studentId, status: { not: 'draft' } },
      select: {
        id: true,
        assignmentId: true,
        status: true,
        gradingStatus: true,
        score: true,
        submittedAt: true,
        gradedAt: true,
        feedback: true,
        assignment: { select: { id: true, title: true, courseId: true } },
      },
      orderBy: { submittedAt: 'desc' },
    }) as unknown as Promise<StudentSubmissionRow[]>;
  }
}
