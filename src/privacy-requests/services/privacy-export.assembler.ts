/**
 * B0-SEC-13 — builds the JSON copy of a person's data.
 *
 * Runs in the PERSON'S OWN RLS context (the caller passes that transaction),
 * so every read is limited by the same `*_self_select` / `*_buyer_select` /
 * `*_payer_select` policies that already decide what they may see: the
 * bundle cannot contain another person's rows even if a filter here were
 * wrong. Every query also filters on the user id explicitly.
 *
 * Names of courses and academies are read separately and joined in memory:
 * a course the person can no longer see (archived, enrolment revoked) must
 * not fail the export — its id is kept and the title is `null`.
 *
 * What is deliberately left out: credentials and 2FA secrets, session and
 * device fingerprints, other people's data (instructor names, reviewer
 * notes, commission figures), and operator-internal fields.
 */
import type { Prisma } from '@prisma/client';
import { EXPORT_FORMAT_VERSION } from '../privacy-requests.constants';

type Tx = Prisma.TransactionClient;

const iso = (value: Date | null | undefined): string | null =>
  value?.toISOString() ?? null;
const decimal = (value: Prisma.Decimal | null | undefined): string | null =>
  value === null || value === undefined ? null : value.toString();

export interface PrivacyExportBundle {
  readonly format: 'atlas-personal-data-export';
  readonly formatVersion: number;
  readonly generatedAt: string;
  readonly account: Record<string, unknown>;
  readonly academies: readonly Record<string, unknown>[];
  readonly enrollments: readonly Record<string, unknown>[];
  readonly lessonProgress: readonly Record<string, unknown>[];
  readonly quizResults: readonly Record<string, unknown>[];
  readonly certificates: readonly Record<string, unknown>[];
  readonly courseOrders: readonly Record<string, unknown>[];
  readonly payments: readonly Record<string, unknown>[];
}

export async function assemblePrivacyExport(
  tx: Tx,
  userId: string,
  now: Date = new Date(),
): Promise<PrivacyExportBundle> {
  const [
    user,
    phone,
    consents,
    memberships,
    enrollments,
    lessonProgress,
    quizResults,
    certificates,
    orders,
    payments,
  ] = await Promise.all([
    tx.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
        preferences: true,
        emailVerifiedAt: true,
        lastSignInAt: true,
        createdAt: true,
      },
    }),
    tx.userPhone.findUnique({
      where: { userId },
      select: { phoneE164: true, countryCode: true, verifiedAt: true },
    }),
    tx.userConsent.findMany({
      where: { userId },
      select: { kind: true, version: true, source: true, acceptedAt: true },
      orderBy: { acceptedAt: 'asc' },
    }),
    tx.academyStudent.findMany({
      where: { userId },
      select: {
        academyId: true,
        status: true,
        joinedAt: true,
        source: true,
        lastActivityAt: true,
      },
      orderBy: { joinedAt: 'asc' },
    }),
    tx.enrollment.findMany({
      where: { studentId: userId },
      select: {
        id: true,
        courseId: true,
        academyId: true,
        status: true,
        accessSource: true,
        enrolledAt: true,
        completedAt: true,
        expiresAt: true,
        revokedAt: true,
        createdAt: true,
        progress: {
          select: {
            percentage: true,
            completedLessons: true,
            totalLessons: true,
            completedItems: true,
            totalItems: true,
            completionState: true,
            timeSpentSeconds: true,
            overallScore: true,
            lastActivityAt: true,
            completedAt: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
    tx.lessonProgress.findMany({
      where: { enrollment: { studentId: userId } },
      select: {
        courseId: true,
        lessonId: true,
        status: true,
        watchedSeconds: true,
        completedAt: true,
        lastActivityAt: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    tx.quizResult.findMany({
      where: { studentId: userId },
      select: {
        quizId: true,
        attemptsCount: true,
        bestScore: true,
        latestScore: true,
        passed: true,
        computedAt: true,
      },
    }),
    tx.certificate.findMany({
      where: { studentId: userId },
      select: {
        id: true,
        courseId: true,
        academyId: true,
        serial: true,
        verificationCode: true,
        status: true,
        issuedAt: true,
        revokedAt: true,
      },
      orderBy: { issuedAt: 'asc' },
    }),
    tx.courseOrder.findMany({
      where: { studentId: userId },
      select: {
        id: true,
        courseId: true,
        academyId: true,
        status: true,
        paidAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    tx.payment.findMany({
      where: { payerUserId: userId },
      select: {
        id: true,
        courseOrderId: true,
        methodType: true,
        provider: true,
        amountMinorUnits: true,
        currency: true,
        status: true,
        reviewStatus: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const courseIds = [
    ...new Set([
      ...enrollments.map((row) => row.courseId),
      ...certificates.map((row) => row.courseId),
      ...orders.map((row) => row.courseId),
    ]),
  ];
  const academyIds = [
    ...new Set([
      ...memberships.map((row) => row.academyId),
      ...enrollments.map((row) => row.academyId),
    ]),
  ];
  const [courses, academies] = await Promise.all([
    courseIds.length
      ? tx.course.findMany({
          where: { id: { in: courseIds } },
          select: { id: true, title: true },
        })
      : [],
    academyIds.length
      ? tx.academy.findMany({
          where: { id: { in: academyIds } },
          select: { id: true, name: true },
        })
      : [],
  ]);
  const courseTitle = new Map(courses.map((row) => [row.id, row.title]));
  const academyName = new Map(academies.map((row) => [row.id, row.name]));

  return {
    format: 'atlas-personal-data-export',
    formatVersion: EXPORT_FORMAT_VERSION,
    generatedAt: now.toISOString(),
    account: {
      id: user?.id ?? userId,
      email: user?.email ?? null,
      name: user?.name ?? null,
      avatarUrl: user?.avatarUrl ?? null,
      preferences: user?.preferences ?? null,
      emailVerifiedAt: iso(user?.emailVerifiedAt),
      lastSignInAt: iso(user?.lastSignInAt),
      createdAt: iso(user?.createdAt),
      phone: phone
        ? {
            number: phone.phoneE164,
            countryCode: phone.countryCode,
            verifiedAt: iso(phone.verifiedAt),
          }
        : null,
      // Mobile app (B4) — terms / privacy / 13+ acceptances.
      consents: consents.map((row) => ({
        kind: row.kind,
        version: row.version,
        source: row.source,
        acceptedAt: iso(row.acceptedAt),
      })),
    },
    academies: memberships.map((row) => ({
      academyId: row.academyId,
      academyName: academyName.get(row.academyId) ?? null,
      status: row.status,
      source: row.source,
      joinedAt: iso(row.joinedAt),
      lastActivityAt: iso(row.lastActivityAt),
    })),
    enrollments: enrollments.map((row) => ({
      id: row.id,
      courseId: row.courseId,
      courseTitle: courseTitle.get(row.courseId) ?? null,
      academyId: row.academyId,
      academyName: academyName.get(row.academyId) ?? null,
      status: row.status,
      accessSource: row.accessSource,
      enrolledAt: iso(row.enrolledAt),
      completedAt: iso(row.completedAt),
      expiresAt: iso(row.expiresAt),
      revokedAt: iso(row.revokedAt),
      progress: row.progress
        ? {
            percentage: decimal(row.progress.percentage),
            completedLessons: row.progress.completedLessons,
            totalLessons: row.progress.totalLessons,
            completedItems: row.progress.completedItems,
            totalItems: row.progress.totalItems,
            completionState: row.progress.completionState,
            timeSpentSeconds: row.progress.timeSpentSeconds,
            overallScore: decimal(row.progress.overallScore),
            lastActivityAt: iso(row.progress.lastActivityAt),
            completedAt: iso(row.progress.completedAt),
          }
        : null,
    })),
    lessonProgress: lessonProgress.map((row) => ({
      courseId: row.courseId,
      lessonId: row.lessonId,
      status: row.status,
      watchedSeconds: row.watchedSeconds,
      completedAt: iso(row.completedAt),
      lastActivityAt: iso(row.lastActivityAt),
    })),
    quizResults: quizResults.map((row) => ({
      quizId: row.quizId,
      attempts: row.attemptsCount,
      bestScore: decimal(row.bestScore),
      latestScore: decimal(row.latestScore),
      passed: row.passed,
      computedAt: iso(row.computedAt),
    })),
    certificates: certificates.map((row) => ({
      id: row.id,
      courseId: row.courseId,
      courseTitle: courseTitle.get(row.courseId) ?? null,
      academyId: row.academyId,
      serial: row.serial,
      verificationCode: row.verificationCode,
      status: row.status,
      issuedAt: iso(row.issuedAt),
      revokedAt: iso(row.revokedAt),
    })),
    courseOrders: orders.map((row) => ({
      id: row.id,
      courseId: row.courseId,
      courseTitle: courseTitle.get(row.courseId) ?? null,
      academyId: row.academyId,
      status: row.status,
      paidAt: iso(row.paidAt),
      createdAt: iso(row.createdAt),
    })),
    payments: payments.map((row) => ({
      id: row.id,
      courseOrderId: row.courseOrderId,
      method: row.methodType,
      provider: row.provider,
      amountMinorUnits: row.amountMinorUnits.toString(),
      currency: row.currency,
      status: row.status,
      reviewStatus: row.reviewStatus,
      createdAt: iso(row.createdAt),
    })),
  };
}
