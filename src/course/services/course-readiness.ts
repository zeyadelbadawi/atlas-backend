/**
 * W6 — course publish readiness: the ONE shared evaluator.
 *
 * `GET /academies/:id/courses/:courseId/publish-readiness` returns its
 * result, and the guided course wizard (frontend) blocks its own Publish
 * button on it. It is a pure function of facts read in one transaction
 * (`readCourseReadinessFacts`), so the endpoint, the wizard and any future
 * server-side enforcement cannot disagree about what "ready" means.
 *
 * BLOCKING CHECKS (`severity: 'blocking'`):
 *   - `publishedActivity` — at least one PUBLISHED activity of ANY kind: a
 *     lesson, a quiz, an assignment, or a scheduled/live/ended live
 *     session. Never "at least one lesson": a quiz-only course is a
 *     supported shape (J15), and learners only ever see published items, so
 *     a course of drafts would publish as an empty shell.
 *   - `paidPrice` — a paid course carries a positive amount and a currency
 *     (exactly what checkout refuses without: `CourseOrdersService`).
 * WARNINGS are advisory (`severity: 'warning'`) and INFO is neutral
 * (`severity: 'info'`); neither affects `ready`.
 *
 * ENFORCEMENT — PHASE 1 IS ADVISORY ONLY. `PUBLISH_READINESS_ENFORCED` is
 * the one-line switch. While it is `false` (today), `CoursesService.publish`
 * never consults this module and the `PATCH … { status }` path is
 * untouched, so every existing publisher (API journeys that publish empty
 * courses, `courses.e2e-spec.ts`, J6) keeps working. Server enforcement is a
 * pending product decision. Turning it on means, together:
 *   1. set `PUBLISH_READINESS_ENFORCED = true` (publish then refuses with
 *      409 `errors.course.notReady` + the failing checks);
 *   2. close the bypass: `UpdateCourseDto.status` can still set
 *      `published` directly — gate or remove it in the same change;
 *   3. update the backend e2e and the FE journeys that publish empty
 *      courses (see the W6 investigation, "Tests to update").
 */
import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/** One-line switch for server-side enforcement — see the header comment before flipping it. */
export const PUBLISH_READINESS_ENFORCED = false;

/** The wizard step a check deep-links to. */
export type CourseReadinessStep =
  'basics' | 'details' | 'media' | 'curriculum' | 'assessments' | 'pricing';

export type CourseReadinessSeverity = 'blocking' | 'warning' | 'info';
export type CourseReadinessStatus = 'pass' | 'fail';

export type CourseReadinessCheckKey =
  | 'title'
  | 'publishedActivity'
  | 'paidPrice'
  | 'shortDescription'
  | 'description'
  | 'thumbnail'
  | 'outcomes'
  | 'draftItems'
  | 'emptySections'
  | 'paymentSetup'
  | 'visibilityPrivate';

export interface CourseReadinessCheck {
  readonly key: CourseReadinessCheckKey;
  readonly status: CourseReadinessStatus;
  readonly severity: CourseReadinessSeverity;
  readonly step: CourseReadinessStep;
  readonly details?: Readonly<Record<string, number | string | boolean>>;
}

export interface CourseReadinessCounts {
  readonly sections: number;
  readonly emptySections: number;
  readonly lessons: number;
  readonly publishedLessons: number;
  readonly quizzes: number;
  readonly publishedQuizzes: number;
  readonly assignments: number;
  readonly publishedAssignments: number;
  readonly publishedLiveSessions: number;
  readonly draftItems: number;
}

export interface CoursePublishReadinessResponse {
  readonly courseId: string;
  /** True when no BLOCKING check fails. Warnings never affect it. */
  readonly ready: boolean;
  /** Whether `POST …/publish` enforces `ready` on the server (Phase 1: false). */
  readonly enforced: boolean;
  readonly checks: readonly CourseReadinessCheck[];
  readonly counts: CourseReadinessCounts;
}

/** The course fields the evaluator reads. */
export interface CourseReadinessCourse {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly shortDescription: string | null;
  readonly description: string | null;
  readonly thumbnailUrl: string | null;
  readonly outcomes: readonly string[];
  readonly visibility: 'public' | 'private';
  readonly pricingType: 'free' | 'paid';
  readonly pricingAmountMinorUnits: bigint | null;
  readonly pricingCurrency: string | null;
}

export interface CourseReadinessFacts {
  readonly counts: CourseReadinessCounts;
  /** Whether the owning organization has chosen a payment collection mode. */
  readonly paymentConfigured: boolean;
}

const LIVE_SESSION_PUBLISHED_STATUSES = ['scheduled', 'live', 'ended'] as const;

function present(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Pure — the same input always yields the same verdict. */
export function evaluateCourseReadiness(
  course: CourseReadinessCourse,
  facts: CourseReadinessFacts,
): CoursePublishReadinessResponse {
  const { counts } = facts;
  const isPaid = course.pricingType === 'paid';
  const publishedActivities =
    counts.publishedLessons +
    counts.publishedQuizzes +
    counts.publishedAssignments +
    counts.publishedLiveSessions;
  const pricePresent =
    course.pricingAmountMinorUnits !== null &&
    course.pricingAmountMinorUnits > 0n &&
    present(course.pricingCurrency);

  const pass = (ok: boolean): CourseReadinessStatus => (ok ? 'pass' : 'fail');

  const checks: CourseReadinessCheck[] = [
    {
      key: 'title',
      status: pass(present(course.title) && present(course.slug)),
      severity: 'blocking',
      step: 'basics',
    },
    {
      key: 'publishedActivity',
      status: pass(publishedActivities > 0),
      severity: 'blocking',
      step: 'curriculum',
      details: {
        publishedLessons: counts.publishedLessons,
        publishedQuizzes: counts.publishedQuizzes,
        publishedAssignments: counts.publishedAssignments,
        publishedLiveSessions: counts.publishedLiveSessions,
        draftItems: counts.draftItems,
      },
    },
    {
      key: 'paidPrice',
      // A free course has no price to miss.
      status: pass(!isPaid || pricePresent),
      severity: 'blocking',
      step: 'pricing',
      details: { pricingType: course.pricingType },
    },
    {
      key: 'shortDescription',
      status: pass(present(course.shortDescription)),
      severity: 'warning',
      step: 'basics',
    },
    {
      key: 'description',
      status: pass(present(course.description)),
      severity: 'warning',
      step: 'details',
    },
    {
      key: 'thumbnail',
      status: pass(present(course.thumbnailUrl)),
      severity: 'warning',
      step: 'media',
    },
    {
      key: 'outcomes',
      status: pass(course.outcomes.some((outcome) => present(outcome))),
      severity: 'warning',
      step: 'details',
    },
    {
      key: 'draftItems',
      status: pass(counts.draftItems === 0),
      severity: 'warning',
      step: 'curriculum',
      details: { draftItems: counts.draftItems },
    },
    {
      key: 'emptySections',
      status: pass(counts.emptySections === 0),
      severity: 'warning',
      step: 'curriculum',
      details: { emptySections: counts.emptySections },
    },
    {
      key: 'paymentSetup',
      // Only a paid course needs the organization to collect payments.
      status: pass(!isPaid || facts.paymentConfigured),
      severity: 'warning',
      step: 'pricing',
    },
    {
      key: 'visibilityPrivate',
      // Not a problem — a private course publishes unlisted. Said so the
      // author is not surprised it is missing from the public catalog.
      status: pass(course.visibility !== 'private'),
      severity: 'info',
      step: 'pricing',
    },
  ];

  const ready = checks.every(
    (check) => check.severity !== 'blocking' || check.status === 'pass',
  );

  return {
    courseId: course.id,
    ready,
    enforced: PUBLISH_READINESS_ENFORCED,
    checks,
    counts,
  };
}

/** Throws the 409 an enforced publish would return. Unused while `PUBLISH_READINESS_ENFORCED` is false. */
export function assertCourseReady(readiness: CoursePublishReadinessResponse): void {
  if (readiness.ready) return;
  throw new ConflictException({
    messageKey: 'errors.course.notReady',
    details: {
      checks: readiness.checks.filter(
        (check) => check.severity === 'blocking' && check.status === 'fail',
      ),
    },
  });
}

/**
 * Reads every fact the evaluator needs in the caller's transaction (tenant
 * context, so RLS scopes every read to the organization). Grouped counts —
 * a fixed number of round trips whatever the course size.
 */
export async function readCourseReadinessFacts(
  tx: Prisma.TransactionClient,
  courseId: string,
  organizationId: string,
): Promise<CourseReadinessFacts> {
  const [
    sections,
    lessonGroups,
    quizGroups,
    assignmentGroups,
    publishedLiveSessions,
    paymentSettings,
  ] = await Promise.all([
    tx.courseSection.findMany({
      where: { courseId },
      select: {
        id: true,
        _count: {
          select: { lessons: true, quizzes: true, assignments: true, liveSessions: true },
        },
      },
    }),
    tx.courseLesson.groupBy({
      by: ['status'],
      where: { courseId },
      _count: { _all: true },
    }),
    tx.quiz.groupBy({ by: ['status'], where: { courseId }, _count: { _all: true } }),
    tx.assignment.groupBy({
      by: ['status'],
      where: { courseId },
      _count: { _all: true },
    }),
    tx.liveSession.count({
      where: { courseId, status: { in: [...LIVE_SESSION_PUBLISHED_STATUSES] } },
    }),
    tx.organizationPaymentSettings.findUnique({
      where: { organizationId },
      select: { paymentCollectionMode: true },
    }),
  ]);

  const tally = (groups: { status: string; _count: { _all: number } }[]) => {
    let total = 0;
    let published = 0;
    for (const group of groups) {
      total += group._count._all;
      if (group.status === 'published') published += group._count._all;
    }
    return { total, published };
  };
  const lessons = tally(lessonGroups);
  const quizzes = tally(quizGroups);
  const assignments = tally(assignmentGroups);

  const emptySections = sections.filter(
    (section) =>
      section._count.lessons +
        section._count.quizzes +
        section._count.assignments +
        section._count.liveSessions ===
      0,
  ).length;

  return {
    counts: {
      sections: sections.length,
      emptySections,
      lessons: lessons.total,
      publishedLessons: lessons.published,
      quizzes: quizzes.total,
      publishedQuizzes: quizzes.published,
      assignments: assignments.total,
      publishedAssignments: assignments.published,
      publishedLiveSessions,
      draftItems:
        lessons.total -
        lessons.published +
        (quizzes.total - quizzes.published) +
        (assignments.total - assignments.published),
    },
    // "No row" is the real `unconfigured` default (see
    // `OrganizationPaymentSettingsService.isConfigured`).
    paymentConfigured:
      !!paymentSettings && paymentSettings.paymentCollectionMode !== 'unconfigured',
  };
}
