/**
 * InstructorService — matches `InstructorService` (atlas frontend)
 * exactly. Every method resolves the caller's teaching scope from
 * `course_instructors` itself (`assertTeachesCourse`, real DB row, never a
 * client-supplied id trusted alone) — the exact rule the frontend
 * service's own header comment states: "the backend is expected to
 * resolve the instructor's authorized course scope itself... this service
 * never accepts an instructor id as a parameter."
 *
 * Runs entirely under `TenancyContextService.runInUserContext` (never
 * `runInTenantContext`) — see schema.prisma's P7 header comment for why:
 * an instructor is resolved by a real `course_instructors` row, not an
 * `organization_memberships` row, matching P6's identical reasoning for
 * students.
 *
 * `coursesRequiringAttention` only ever emits `'pending_grading'` — the
 * one `CourseAttentionReason` backed by an unambiguous real fact
 * (`pendingGradingCount > 0`). `'low_engagement'`/`'no_recent_activity'`
 * are real frontend union members with no defined threshold anywhere
 * (master plan §24's "do not invent business rules" rule) — never
 * emitted, not silently mapped to an arbitrary cutoff.
 */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { CourseInstructorsRepository } from '../../course/repositories/course-instructors.repository';
import {
  InstructorRepository,
  type EnrollmentWithStudent,
} from '../repositories/instructor.repository';
import { toCourseProgressResponse } from '../../learning/dto/course-progress.contract';
import { toQuizAttemptResponse } from '../../learning/dto/quiz-attempt.contract';
import {
  toAssignmentSubmissionReviewResponse,
  toQuizAttemptSummaryResponse,
} from '../dto/instructor.contract';
import type {
  AssignmentSubmissionReviewResponse,
  CourseAttentionItemResponse,
  InstructorActivityItemResponse,
  InstructorCourseOverviewResponse,
  InstructorDashboardMetricsResponse,
  InstructorStudentProgressResponse,
  InstructorStudentResponse,
  QuizAttemptSummaryResponse,
  TeachingCourseResponse,
} from '../dto/instructor.contract';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type { GradeSubmissionDto } from '../dto/grade-submission.dto';
import type { Prisma } from '@prisma/client';

const RECENT_ACTIVITY_LIMIT = 10;

function toEnrollmentStudentResponse(
  enrollment: EnrollmentWithStudent,
): InstructorStudentResponse {
  return {
    studentId: enrollment.student.id,
    name: enrollment.student.name,
    email: enrollment.student.email,
    enrollmentStatus: enrollment.status,
    progressPercentage: enrollment.progress ? Number(enrollment.progress.percentage) : 0,
    completionState: enrollment.progress?.completionState ?? 'incomplete',
    lastActivityAt: (
      enrollment.progress?.updatedAt ?? enrollment.updatedAt
    ).toISOString(),
  };
}

function paginationOf(query?: CollectionQueryDto): {
  skip: number;
  take: number;
  page: number;
  pageSize: number;
} {
  const page = query?.page ?? DEFAULT_PAGE;
  const pageSize = query?.pageSize ?? DEFAULT_PAGE_SIZE;
  return { skip: (page - 1) * pageSize, take: pageSize, page, pageSize };
}

@Injectable()
export class InstructorService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly courseInstructorsRepository: CourseInstructorsRepository,
    private readonly instructorRepository: InstructorRepository,
  ) {}

  private async assertTeachesCourse(
    tx: Prisma.TransactionClient,
    userId: string,
    courseId: string,
  ): Promise<void> {
    const isInstructor = await this.courseInstructorsRepository.isInstructor(
      tx,
      courseId,
      userId,
    );
    if (!isInstructor) {
      // 404, not 403 — matches every other "draft/unreachable content
      // looks like it doesn't exist" precedent in this codebase
      // (`assertActiveEnrollment`'s own doc comment, P6) rather than
      // confirming to an unauthorized caller that the course exists.
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
  }

  private async buildActivityFeed(
    tx: Prisma.TransactionClient,
    courseIds: readonly string[],
  ): Promise<InstructorActivityItemResponse[]> {
    if (courseIds.length === 0) return [];

    const [enrollments, quizAttempts, submissions] = await Promise.all([
      this.instructorRepository.findRecentEnrollments(
        tx,
        courseIds,
        RECENT_ACTIVITY_LIMIT,
      ),
      this.instructorRepository.findRecentQuizAttempts(
        tx,
        courseIds,
        RECENT_ACTIVITY_LIMIT,
      ),
      this.instructorRepository.findRecentSubmissions(
        tx,
        courseIds,
        RECENT_ACTIVITY_LIMIT,
      ),
    ]);

    const items: (InstructorActivityItemResponse & { sortKey: number })[] = [
      ...enrollments.map((e) => ({
        id: `enrollment-${e.id}`,
        type: 'enrollment' as const,
        courseId: e.courseId,
        courseTitle: e.course.title,
        studentName: e.student.name,
        description: `${e.student.name} enrolled in ${e.course.title}`,
        timestamp: e.createdAt.toISOString(),
        sortKey: e.createdAt.getTime(),
      })),
      ...quizAttempts
        .filter((a) => a.submittedAt !== null)
        .map((a) => ({
          id: `quiz-attempt-${a.id}`,
          type: 'quiz_attempt' as const,
          courseId: a.quiz.courseId,
          courseTitle: a.quiz.course.title,
          studentName: a.student.name,
          description: `${a.student.name} ${a.status === 'passed' ? 'passed' : 'attempted'} ${a.quiz.title}`,
          timestamp: a.submittedAt!.toISOString(),
          sortKey: a.submittedAt!.getTime(),
        })),
      ...submissions
        .filter((s) => s.submittedAt !== null)
        .map((s) => ({
          id: `submission-${s.id}`,
          type: 'submission' as const,
          courseId: s.assignment.courseId,
          courseTitle: s.assignment.course.title,
          studentName: s.student.name,
          description: `${s.student.name} submitted ${s.assignment.title}`,
          timestamp: s.submittedAt!.toISOString(),
          sortKey: s.submittedAt!.getTime(),
        })),
    ];

    return items
      .sort((a, b) => b.sortKey - a.sortKey)
      .slice(0, RECENT_ACTIVITY_LIMIT)
      .map(({ sortKey: _sortKey, ...item }) => item);
  }

  async getDashboard(userId: string): Promise<InstructorDashboardMetricsResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const courseIds = await this.courseInstructorsRepository.findCourseIdsForInstructor(
        tx,
        userId,
      );

      if (courseIds.length === 0) {
        return {
          assignedCoursesCount: 0,
          activeCoursesCount: 0,
          totalStudents: 0,
          pendingSubmissionsCount: 0,
          pendingGradingCount: 0,
          coursesRequiringAttention: [],
          recentActivity: [],
        };
      }

      const [
        activeCoursesCount,
        totalStudents,
        pendingSubmissionsCount,
        pendingGradingCount,
        courses,
        recentActivity,
      ] = await Promise.all([
        this.instructorRepository.countPublishedAmong(tx, courseIds),
        this.instructorRepository.countDistinctActiveStudents(tx, courseIds),
        this.instructorRepository.countPendingSubmissions(tx, courseIds),
        this.instructorRepository.countPendingGrading(tx, courseIds),
        this.instructorRepository.findCoursesByIds(tx, courseIds, {
          skip: 0,
          take: courseIds.length,
        }),
        this.buildActivityFeed(tx, courseIds),
      ]);

      const attentionEntries = await Promise.all(
        courses.items.map(async (course): Promise<CourseAttentionItemResponse | null> => {
          const pending = await this.instructorRepository.countPendingGrading(tx, [
            course.id,
          ]);
          return pending > 0
            ? {
                courseId: course.id,
                courseTitle: course.title,
                reason: 'pending_grading',
              }
            : null;
        }),
      );

      return {
        assignedCoursesCount: courseIds.length,
        activeCoursesCount,
        totalStudents,
        pendingSubmissionsCount,
        pendingGradingCount,
        coursesRequiringAttention: attentionEntries.filter(
          (entry): entry is CourseAttentionItemResponse => entry !== null,
        ),
        recentActivity,
      };
    });
  }

  async getTeachingCourses(
    userId: string,
    query?: CollectionQueryDto,
  ): Promise<PaginatedResult<TeachingCourseResponse>> {
    const { skip, take, page, pageSize } = paginationOf(query);
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const courseIds = await this.courseInstructorsRepository.findCourseIdsForInstructor(
        tx,
        userId,
      );
      if (courseIds.length === 0) {
        return { items: [], pagination: buildPaginationMeta(page, pageSize, 0) };
      }

      const { items, totalItems } = await this.instructorRepository.findCoursesByIds(
        tx,
        courseIds,
        { skip, take },
      );

      const responses = await Promise.all(
        items.map(async (course) => {
          const [enrolledCount, averageProgress, pendingGradingCount] = await Promise.all(
            [
              this.instructorRepository.countActiveEnrollmentsForCourse(tx, course.id),
              this.instructorRepository.averageProgressForCourse(tx, course.id),
              this.instructorRepository.countPendingGrading(tx, [course.id]),
            ],
          );
          return {
            courseId: course.id,
            title: course.title,
            thumbnail: course.thumbnailUrl ?? undefined,
            status: course.status,
            visibility: course.visibility,
            enrolledCount,
            averageProgress,
            requiresAttention: pendingGradingCount > 0,
          } satisfies TeachingCourseResponse;
        }),
      );

      return {
        items: responses,
        pagination: buildPaginationMeta(page, pageSize, totalItems),
      };
    });
  }

  async getCourseOverview(
    userId: string,
    courseId: string,
  ): Promise<InstructorCourseOverviewResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await this.assertTeachesCourse(tx, userId, courseId);
      const course = await this.instructorRepository.findCourseById(tx, courseId);
      if (!course) throw new NotFoundException({ messageKey: 'errors.notFound' });

      const [
        enrolledCount,
        averageProgress,
        pendingSubmissionsCount,
        pendingGradingCount,
        recentActivity,
      ] = await Promise.all([
        this.instructorRepository.countActiveEnrollmentsForCourse(tx, courseId),
        this.instructorRepository.averageProgressForCourse(tx, courseId),
        this.instructorRepository.countPendingSubmissions(tx, [courseId]),
        this.instructorRepository.countPendingGrading(tx, [courseId]),
        this.buildActivityFeed(tx, [courseId]),
      ]);

      return {
        courseId: course.id,
        title: course.title,
        description: course.description ?? undefined,
        status: course.status,
        visibility: course.visibility,
        enrolledCount,
        averageProgress,
        totalSections: await tx.courseSection.count({ where: { courseId } }),
        totalLessons: await tx.courseLesson.count({ where: { courseId } }),
        pendingSubmissionsCount,
        pendingGradingCount,
        recentActivity,
      };
    });
  }

  async getCourseStudents(
    userId: string,
    courseId: string,
    query?: CollectionQueryDto,
  ): Promise<PaginatedResult<InstructorStudentResponse>> {
    const { skip, take, page, pageSize } = paginationOf(query);
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await this.assertTeachesCourse(tx, userId, courseId);
      const { items, totalItems } = await this.instructorRepository.findEnrolledStudents(
        tx,
        courseId,
        { skip, take },
      );
      return {
        items: items.map(toEnrollmentStudentResponse),
        pagination: buildPaginationMeta(page, pageSize, totalItems),
      };
    });
  }

  async getStudentProgress(
    userId: string,
    courseId: string,
    studentId: string,
  ): Promise<InstructorStudentProgressResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await this.assertTeachesCourse(tx, userId, courseId);
      const enrollment = await this.instructorRepository.findEnrollmentWithProgress(
        tx,
        courseId,
        studentId,
      );
      if (!enrollment || !enrollment.progress) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }

      const [lessonProgressRows, quizAttempts, submissions] = await Promise.all([
        tx.lessonProgress.findMany({
          where: { enrollmentId: enrollment.id },
          include: {
            lesson: { select: { order: true, section: { select: { order: true } } } },
          },
        }),
        this.instructorRepository.findQuizAttemptsForStudentInCourse(
          tx,
          studentId,
          courseId,
        ),
        this.instructorRepository.findSubmissionsForStudentInCourse(
          tx,
          studentId,
          courseId,
        ),
      ]);

      const sortedLessonProgress = lessonProgressRows
        .slice()
        .sort((a, b) => {
          const delta = a.lesson.section.order - b.lesson.section.order;
          return delta !== 0 ? delta : a.lesson.order - b.lesson.order;
        })
        .map(({ lesson: _lesson, ...row }) => row);

      const submissionsWithNames: AssignmentSubmissionReviewResponse[] = submissions.map(
        (s) => toAssignmentSubmissionReviewResponse(s, enrollment.student.name),
      );

      return {
        studentId: enrollment.student.id,
        studentName: enrollment.student.name,
        courseId,
        enrollmentStatus: enrollment.status,
        progress: toCourseProgressResponse(
          courseId,
          enrollment.progress,
          sortedLessonProgress,
        ),
        quizAttempts: quizAttempts.map((attempt) =>
          toQuizAttemptResponse(attempt, false),
        ),
        assignmentSubmissions: submissionsWithNames,
      };
    });
  }

  async getQuizAttempts(
    userId: string,
    courseId: string,
    quizId: string,
    query?: CollectionQueryDto,
  ): Promise<PaginatedResult<QuizAttemptSummaryResponse>> {
    const { skip, take, page, pageSize } = paginationOf(query);
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await this.assertTeachesCourse(tx, userId, courseId);
      const quiz = await this.instructorRepository.findQuizById(tx, quizId);
      if (!quiz || quiz.courseId !== courseId) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }

      const { items, totalItems } =
        await this.instructorRepository.findQuizAttemptsForQuiz(tx, quizId, {
          skip,
          take,
        });

      return {
        items: items.map((attempt) =>
          toQuizAttemptSummaryResponse(attempt, false, attempt.student.name),
        ),
        pagination: buildPaginationMeta(page, pageSize, totalItems),
      };
    });
  }

  async getAssignmentSubmissions(
    userId: string,
    courseId: string,
    assignmentId: string,
    query?: CollectionQueryDto,
  ): Promise<PaginatedResult<AssignmentSubmissionReviewResponse>> {
    const { skip, take, page, pageSize } = paginationOf(query);
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await this.assertTeachesCourse(tx, userId, courseId);
      const assignment = await this.instructorRepository.findAssignmentById(
        tx,
        assignmentId,
      );
      if (!assignment || assignment.courseId !== courseId) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }

      const { items, totalItems } =
        await this.instructorRepository.findSubmissionsForAssignment(tx, assignmentId, {
          skip,
          take,
        });

      return {
        items: items.map((submission) =>
          toAssignmentSubmissionReviewResponse(submission, submission.student.name),
        ),
        pagination: buildPaginationMeta(page, pageSize, totalItems),
      };
    });
  }

  async getSubmission(
    userId: string,
    courseId: string,
    assignmentId: string,
    submissionId: string,
  ): Promise<AssignmentSubmissionReviewResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await this.assertTeachesCourse(tx, userId, courseId);
      const submission = await this.instructorRepository.findSubmissionById(
        tx,
        submissionId,
      );
      if (!submission || submission.assignmentId !== assignmentId) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }
      const assignment = await this.instructorRepository.findAssignmentById(
        tx,
        assignmentId,
      );
      if (!assignment || assignment.courseId !== courseId) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }
      return toAssignmentSubmissionReviewResponse(submission, submission.student.name);
    });
  }

  async gradeSubmission(
    userId: string,
    courseId: string,
    assignmentId: string,
    submissionId: string,
    payload: GradeSubmissionDto,
  ): Promise<AssignmentSubmissionReviewResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await this.assertTeachesCourse(tx, userId, courseId);
      const assignment = await this.instructorRepository.findAssignmentById(
        tx,
        assignmentId,
      );
      if (!assignment || assignment.courseId !== courseId) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }
      const submission = await this.instructorRepository.findSubmissionById(
        tx,
        submissionId,
      );
      if (!submission || submission.assignmentId !== assignmentId) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }
      if (submission.status !== 'submitted') {
        throw new ForbiddenException({ messageKey: 'errors.submission.notSubmitted' });
      }

      const graded = await this.instructorRepository.gradeSubmission(tx, submissionId, {
        score: payload.score,
        feedback: payload.feedback,
        gradedBy: userId,
      });

      return toAssignmentSubmissionReviewResponse(graded, submission.student.name);
    });
  }
}
