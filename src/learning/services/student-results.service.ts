/**
 * StudentResultsService — assembles `GET /learning/results` (Phase 9,
 * "My Results").
 *
 * Runs entirely under `TenancyContextService.runInUserContext(studentId)`,
 * the same context every other student-facing learning read uses. That is
 * what makes this safe: `quiz_attempts_self_select` /
 * `assignment_submissions_self_select` (RLS) restrict both tables to the
 * acting student at the database level, and the repository additionally
 * filters on `studentId`. The service never accepts a student id from the
 * request — the controller passes the authenticated user's own id and
 * nothing else, so there is no parameter for a caller to tamper with.
 *
 * Results are grouped under the student's OWN enrollments. An attempt or
 * submission whose course the student is no longer enrolled in is
 * therefore not shown — it is their data, but with no course context left
 * to render it in, and inventing a placeholder course would be exactly
 * the kind of fabrication this phase forbids.
 *
 * `academyId` (optional) narrows results to one Academy, reusing
 * `EnrollmentsRepository.findManyForStudent`'s existing academy filter —
 * the same mechanism the Academy-website-embedded My Learning already
 * uses so one Academy's surface never shows another Academy's data.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { EnrollmentsRepository } from '../repositories/enrollments.repository';
import { StudentResultsRepository } from '../repositories/student-results.repository';
import { CourseProgressRepository } from '../repositories/course-progress.repository';
import type {
  StudentAssignmentResultResponse,
  StudentCourseResultsResponse,
  StudentQuizResultResponse,
  StudentResultsResponse,
} from '../dto/student-results.contract';

/** Deliberately generous: "My Results" is a complete personal record, not a paged feed. Still bounded so one pathological account cannot return an unbounded row set. */
const MAX_COURSES = 200;

function toNumber(value: Prisma.Decimal | null): number | null {
  return value === null ? null : Number(value);
}

@Injectable()
export class StudentResultsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly enrollmentsRepository: EnrollmentsRepository,
    private readonly studentResultsRepository: StudentResultsRepository,
    private readonly courseProgressRepository: CourseProgressRepository,
  ) {}

  async getMyResults(
    studentId: string,
    academyId?: string,
  ): Promise<StudentResultsResponse> {
    return this.tenancyContextService.runInUserContext(studentId, async (tx) => {
      const [{ items: enrollments }, attempts, submissions] = await Promise.all([
        this.enrollmentsRepository.findManyForStudent(tx, studentId, {
          skip: 0,
          take: MAX_COURSES,
          academyId,
        }),
        this.studentResultsRepository.findQuizAttemptsForStudent(tx, studentId),
        this.studentResultsRepository.findSubmissionsForStudent(tx, studentId),
      ]);

      const quizzesByCourse = new Map<string, StudentQuizResultResponse[]>();
      for (const attempt of attempts) {
        const list = quizzesByCourse.get(attempt.quiz.courseId) ?? [];
        list.push({
          attemptId: attempt.id,
          quizId: attempt.quizId,
          quizTitle: attempt.quiz.title,
          attemptNumber: attempt.attemptNumber,
          score: toNumber(attempt.score),
          // `passed` stays null when the quiz defines no passing score —
          // see the contract's honesty rules.
          passed: attempt.quiz.passingScore === null ? null : attempt.passed,
          submittedAt: attempt.submittedAt?.toISOString() ?? null,
        });
        quizzesByCourse.set(attempt.quiz.courseId, list);
      }

      const assignmentsByCourse = new Map<string, StudentAssignmentResultResponse[]>();
      for (const submission of submissions) {
        const list = assignmentsByCourse.get(submission.assignment.courseId) ?? [];
        list.push({
          submissionId: submission.id,
          assignmentId: submission.assignmentId,
          assignmentTitle: submission.assignment.title,
          status: submission.status,
          gradingStatus: submission.gradingStatus,
          score: toNumber(submission.score),
          // The feedback text itself is intentionally not returned here —
          // this is an at-a-glance results list, and the assignment page
          // is where a student reads the full feedback. Only whether
          // feedback exists is needed to render the indicator.
          hasFeedback: Boolean(submission.feedback && submission.feedback.trim()),
          submittedAt: submission.submittedAt?.toISOString() ?? null,
          gradedAt: submission.gradedAt?.toISOString() ?? null,
        });
        assignmentsByCourse.set(submission.assignment.courseId, list);
      }

      // Batched in one round trip, reusing the exact helper
      // `EnrollmentsService.list` already uses for the My Learning cards —
      // so both surfaces read the same materialized `CourseProgress` rows
      // and can never disagree about a student's progress.
      const progressByEnrollmentId =
        await this.courseProgressRepository.findManyByEnrollmentIds(
          tx,
          enrollments.map((enrollment) => enrollment.id),
        );

      const courses: StudentCourseResultsResponse[] = enrollments.map((enrollment) => {
        const progress = progressByEnrollmentId.get(enrollment.id);
        return {
          courseId: enrollment.courseId,
          courseTitle: enrollment.course.title,
          academyId: enrollment.academyId,
          progress: progress
            ? {
                completedLessons: progress.completedLessons,
                totalLessons: progress.totalLessons,
                percentage: Number(progress.percentage),
                completionState: progress.completionState,
              }
            : null,
          quizResults: quizzesByCourse.get(enrollment.courseId) ?? [],
          assignmentResults: assignmentsByCourse.get(enrollment.courseId) ?? [],
        };
      });

      return { summary: this.buildSummary(courses), courses };
    });
  }

  /**
   * Every figure is a straight count over the rows above — nothing is
   * estimated or extrapolated. `averageQuizScore` averages only attempts
   * that actually carry a score, and is `null` rather than `0` when there
   * are none.
   */
  private buildSummary(
    courses: readonly StudentCourseResultsResponse[],
  ): StudentResultsResponse['summary'] {
    const quizResults = courses.flatMap((course) => course.quizResults);
    const assignmentResults = courses.flatMap((course) => course.assignmentResults);
    const scored = quizResults.filter(
      (result): result is StudentQuizResultResponse & { score: number } =>
        result.score !== null,
    );

    return {
      coursesEnrolled: courses.length,
      coursesCompleted: courses.filter(
        (course) => course.progress?.completionState === 'completed',
      ).length,
      quizzesAttempted: quizResults.length,
      quizzesPassed: quizResults.filter((result) => result.passed === true).length,
      assignmentsSubmitted: assignmentResults.length,
      assignmentsGraded: assignmentResults.filter(
        (result) => result.gradingStatus === 'graded',
      ).length,
      averageQuizScore:
        scored.length === 0
          ? null
          : Math.round(
              (scored.reduce((total, result) => total + result.score, 0) /
                scored.length) *
                10,
            ) / 10,
    };
  }
}
