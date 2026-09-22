/**
 * The learner dashboard's aggregates (master plan Phase 2 §D.8, §E.1;
 * Finding F1).
 *
 * WHY THE SERVER ASSEMBLES THIS. Before P64 the learner's "dashboard" was
 * a page in the STAFF dashboard shell that stitched together several
 * unrelated endpoints in the browser, counted whatever a page of results
 * happened to contain, and had no notion of which academy it was showing.
 * Three consequences, all of them findings: counts were wrong past the
 * first page, the learner saw staff chrome they had no business seeing
 * (F1), and a learner of two academies saw both academies' work mixed
 * together on one academy's branded site.
 *
 * EVERYTHING HERE IS SCOPED TO THE HOST ACADEMY, and the scope comes from
 * the request host — never from a parameter a caller can change. A person
 * really can be a learner at several academies with one account (AD-4);
 * what must never happen is one academy's site showing another's courses.
 *
 * Reads run in the learner's own user context, so every RLS policy that
 * governs their enrollments, attempts and submissions applies. The
 * academy filter and RLS agree: the filter narrows to one academy, RLS
 * independently refuses anything that is not theirs.
 */
import { FeatureFlagsService } from '../../common/flags/feature-flags.service';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { ACTIVE_ENROLLMENT_STATUSES } from '../dto/learning.constants';
import type {
  ContinueLearningItem,
  LearnerAnnouncement,
  LearnerAssessmentItem,
  LearnerOverviewResponse,
  RecentResult,
  UpcomingDeadline,
} from '../dto/learner-overview.contract';

/** How many of each list the overview carries. A dashboard summarises; the dedicated pages paginate. */
const OVERVIEW_LIMIT = 5;

/** How far ahead "upcoming" looks. Beyond this a deadline is not something to act on today. */
const DEADLINE_HORIZON_DAYS = 30;

@Injectable()
export class LearnerDashboardService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  async getOverview(userId: string, academyId: string): Promise<LearnerOverviewResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const enrollments = await tx.enrollment.findMany({
        where: {
          studentId: userId,
          academyId,
          status: { in: [...ACTIVE_ENROLLMENT_STATUSES] },
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: {
          id: true,
          courseId: true,
          status: true,
          course: { select: { id: true, title: true, thumbnailUrl: true } },
          progress: {
            select: {
              percentage: true,
              completedLessons: true,
              totalLessons: true,
              currentLessonId: true,
              completionState: true,
              lastActivityAt: true,
            },
          },
        },
      });

      const courseIds = enrollments.map((row) => row.courseId);

      const continueLearning: ContinueLearningItem[] = enrollments
        .filter((row) => row.progress && row.progress.completionState !== 'completed')
        // Most recently touched first. `lastActivityAt` rather than
        // `updatedAt`: a recompute rewrites every enrollment's row at once
        // and would reorder the list without the learner doing anything.
        .sort(
          (a, b) =>
            (b.progress?.lastActivityAt?.getTime() ?? 0) -
            (a.progress?.lastActivityAt?.getTime() ?? 0),
        )
        .slice(0, OVERVIEW_LIMIT)
        .map((row) => ({
          courseId: row.courseId,
          courseTitle: row.course.title,
          courseThumbnailUrl: row.course.thumbnailUrl,
          percentage: Number(row.progress?.percentage ?? 0),
          completedLessons: row.progress?.completedLessons ?? 0,
          totalLessons: row.progress?.totalLessons ?? 0,
          nextItemId: row.progress?.currentLessonId ?? null,
          nextItemTitle: null,
          lastActivityAt: row.progress?.lastActivityAt?.toISOString() ?? null,
        }));

      // The titles for the "Next: …" labels, in one query rather than one
      // per card.
      const nextLessonIds = continueLearning
        .map((item) => item.nextItemId)
        .filter((id): id is string => Boolean(id));
      const nextLessons = nextLessonIds.length
        ? await tx.courseLesson.findMany({
            where: { id: { in: nextLessonIds } },
            select: { id: true, title: true },
          })
        : [];
      const nextTitles = new Map(nextLessons.map((lesson) => [lesson.id, lesson.title]));

      const horizon = new Date(Date.now() + DEADLINE_HORIZON_DAYS * 24 * 60 * 60 * 1000);
      const [deadlines, quizResults, assignmentResults, announcements] =
        await Promise.all([
          this.upcomingDeadlines(tx, userId, courseIds, horizon),
          this.recentQuizResults(tx, userId, courseIds),
          this.recentAssignmentResults(tx, userId, courseIds),
          this.announcements(tx, academyId, courseIds),
        ]);

      const recentResults = [...quizResults, ...assignmentResults]
        .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
        .slice(0, OVERVIEW_LIMIT);

      const certificatesEnabled = this.featureFlags.isEnabledForAcademy(
        'certificates',
        academyId,
      );
      const issuedCertificates = certificatesEnabled
        ? await tx.certificate.count({
            where: { studentId: userId, academyId, status: 'issued' },
          })
        : 0;
      return {
        academyId,
        continueLearning: continueLearning.map((item) => ({
          ...item,
          nextItemTitle: item.nextItemId
            ? (nextTitles.get(item.nextItemId) ?? null)
            : null,
        })),
        courseCounts: {
          all: enrollments.length,
          inProgress: enrollments.filter(
            (row) => row.progress?.completionState !== 'completed',
          ).length,
          completed: enrollments.filter(
            (row) => row.progress?.completionState === 'completed',
          ).length,
        },
        upcomingDeadlines: deadlines,
        recentResults,
        announcements,
        // Phase 3 owns certificates. Saying so explicitly is the honest
        // shape: an empty array alone would read as "you have earned none".
        certificates: {
          available: certificatesEnabled,
          count: certificatesEnabled ? issuedCertificates : 0,
        },
      };
    });
  }

  /** The Assessments page — one list per type, across every course in THIS academy. */
  async getAssessments(
    userId: string,
    academyId: string,
    type: 'quiz' | 'assignment',
  ): Promise<readonly LearnerAssessmentItem[]> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const courseIds = await this.activeCourseIds(tx, userId, academyId);
      if (courseIds.length === 0) return [];

      if (type === 'quiz') {
        const quizzes = await tx.quiz.findMany({
          where: { courseId: { in: courseIds }, status: 'published' },
          select: {
            id: true,
            title: true,
            courseId: true,
            course: { select: { title: true } },
          },
        });
        const attempts = await tx.quizAttempt.findMany({
          where: { studentId: userId, quizId: { in: quizzes.map((q) => q.id) } },
          select: {
            quizId: true,
            status: true,
            score: true,
            submittedAt: true,
            attemptNumber: true,
          },
          orderBy: { attemptNumber: 'desc' },
        });
        // First row per quiz is the highest attempt number — the latest
        // attempt, which is what a learner means by "my result".
        const latest = new Map<string, (typeof attempts)[number]>();
        for (const attempt of attempts) {
          if (!latest.has(attempt.quizId)) latest.set(attempt.quizId, attempt);
        }
        return quizzes.map((quiz) => {
          const attempt = latest.get(quiz.id);
          return {
            id: quiz.id,
            type: 'quiz' as const,
            title: quiz.title,
            courseId: quiz.courseId,
            courseTitle: quiz.course.title,
            state: attempt?.status ?? 'not_started',
            dueAt: null,
            score: attempt?.score ? Number(attempt.score) : null,
            submittedAt: attempt?.submittedAt?.toISOString() ?? null,
          };
        });
      }

      const assignments = await tx.assignment.findMany({
        where: { courseId: { in: courseIds }, status: 'published' },
        select: {
          id: true,
          title: true,
          courseId: true,
          dueAt: true,
          course: { select: { title: true } },
        },
      });
      const submissions = await tx.assignmentSubmission.findMany({
        where: { studentId: userId, assignmentId: { in: assignments.map((a) => a.id) } },
        select: {
          assignmentId: true,
          status: true,
          gradingStatus: true,
          score: true,
          submittedAt: true,
        },
      });
      const byAssignment = new Map(submissions.map((row) => [row.assignmentId, row]));
      const now = Date.now();
      return assignments.map((assignment) => {
        const submission = byAssignment.get(assignment.id);
        return {
          id: assignment.id,
          type: 'assignment' as const,
          title: assignment.title,
          courseId: assignment.courseId,
          courseTitle: assignment.course.title,
          state: submission
            ? submission.gradingStatus === 'graded'
              ? 'graded'
              : submission.status
            : assignment.dueAt && assignment.dueAt.getTime() < now
              ? 'overdue'
              : 'not_started',
          dueAt: assignment.dueAt?.toISOString() ?? null,
          score: submission?.score ? Number(submission.score) : null,
          submittedAt: submission?.submittedAt?.toISOString() ?? null,
        };
      });
    });
  }

  private async activeCourseIds(
    tx: Prisma.TransactionClient,
    userId: string,
    academyId: string,
  ): Promise<string[]> {
    const rows = await tx.enrollment.findMany({
      where: {
        studentId: userId,
        academyId,
        status: { in: [...ACTIVE_ENROLLMENT_STATUSES] },
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { courseId: true },
    });
    return rows.map((row) => row.courseId);
  }

  private async upcomingDeadlines(
    tx: Prisma.TransactionClient,
    userId: string,
    courseIds: readonly string[],
    horizon: Date,
  ): Promise<readonly UpcomingDeadline[]> {
    if (courseIds.length === 0) return [];
    const now = new Date();
    const assignments = await tx.assignment.findMany({
      where: {
        courseId: { in: [...courseIds] },
        status: 'published',
        dueAt: { not: null, lte: horizon },
      },
      select: {
        id: true,
        title: true,
        courseId: true,
        dueAt: true,
        course: { select: { title: true } },
        submissions: {
          where: { studentId: userId },
          select: { status: true, gradingStatus: true },
        },
      },
      orderBy: { dueAt: 'asc' },
      take: OVERVIEW_LIMIT * 2,
    });

    return (
      assignments
        // A deadline the learner has already met is not a deadline. Showing
        // it would train them to ignore the list.
        .filter((assignment) => {
          const submission = assignment.submissions[0];
          return !submission || submission.status !== 'submitted';
        })
        .slice(0, OVERVIEW_LIMIT)
        .map((assignment) => ({
          id: assignment.id,
          type: 'assignment' as const,
          title: assignment.title,
          courseId: assignment.courseId,
          courseTitle: assignment.course.title,
          dueAt: assignment.dueAt!.toISOString(),
          overdue: assignment.dueAt!.getTime() < now.getTime(),
        }))
    );
  }

  private async recentQuizResults(
    tx: Prisma.TransactionClient,
    userId: string,
    courseIds: readonly string[],
  ): Promise<readonly RecentResult[]> {
    if (courseIds.length === 0) return [];
    const attempts = await tx.quizAttempt.findMany({
      where: {
        studentId: userId,
        submittedAt: { not: null },
        quiz: { courseId: { in: [...courseIds] } },
      },
      select: {
        id: true,
        status: true,
        score: true,
        submittedAt: true,
        quiz: {
          select: { title: true, courseId: true, course: { select: { title: true } } },
        },
      },
      orderBy: { submittedAt: 'desc' },
      take: OVERVIEW_LIMIT,
    });
    return attempts.map((attempt) => ({
      id: attempt.id,
      type: 'quiz' as const,
      title: attempt.quiz.title,
      courseId: attempt.quiz.courseId,
      courseTitle: attempt.quiz.course.title,
      status: attempt.status,
      score: attempt.score ? Number(attempt.score) : null,
      at: attempt.submittedAt!.toISOString(),
    }));
  }

  private async recentAssignmentResults(
    tx: Prisma.TransactionClient,
    userId: string,
    courseIds: readonly string[],
  ): Promise<readonly RecentResult[]> {
    if (courseIds.length === 0) return [];
    const submissions = await tx.assignmentSubmission.findMany({
      where: {
        studentId: userId,
        gradingStatus: 'graded',
        assignment: { courseId: { in: [...courseIds] } },
      },
      select: {
        id: true,
        status: true,
        gradingStatus: true,
        score: true,
        submittedAt: true,
        updatedAt: true,
        assignment: {
          select: { title: true, courseId: true, course: { select: { title: true } } },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: OVERVIEW_LIMIT,
    });
    return submissions.map((submission) => ({
      id: submission.id,
      type: 'assignment' as const,
      title: submission.assignment.title,
      courseId: submission.assignment.courseId,
      courseTitle: submission.assignment.course.title,
      status: 'graded',
      score: submission.score ? Number(submission.score) : null,
      // The GRADING time, which is what makes this a recent result — the
      // submission may have been weeks earlier.
      at: submission.updatedAt.toISOString(),
    }));
  }

  private async announcements(
    tx: Prisma.TransactionClient,
    academyId: string,
    courseIds: readonly string[],
  ): Promise<readonly LearnerAnnouncement[]> {
    const rows = await tx.announcement.findMany({
      where: {
        status: 'published',
        OR: [
          { academyId, courseId: null },
          ...(courseIds.length ? [{ courseId: { in: [...courseIds] } }] : []),
        ],
      },
      select: { id: true, title: true, body: true, publishedAt: true, courseId: true },
      orderBy: { publishedAt: 'desc' },
      take: OVERVIEW_LIMIT,
    });
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      courseId: row.courseId,
    }));
  }
}
