/**
 * P64 Phase 1 — response contracts for the academy student roster.
 */
import type { AcademyInvite } from '@prisma/client';
import type {
  RosterEnrollmentRow,
  RosterStudentRow,
} from '../repositories/academy-roster.repository';

export interface AcademyRosterStudentResponse {
  readonly membershipId: string;
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly avatar?: string;
  readonly accountStatus: string;
  readonly emailVerified: boolean;
  readonly membershipStatus: string;
  readonly blocked: boolean;
  readonly blockedAt?: string;
  readonly blockedReason?: string;
  readonly source: string;
  readonly joinedAt: string;
  readonly lastActivityAt?: string;
  readonly enrollmentCount: number;
  readonly activeEnrollmentCount: number;
}

export function toAcademyRosterStudentResponse(
  row: RosterStudentRow,
): AcademyRosterStudentResponse {
  return {
    membershipId: row.id,
    userId: row.userId,
    name: row.user.name,
    email: row.user.email,
    avatar: row.user.avatarUrl ?? undefined,
    accountStatus: row.user.status,
    emailVerified: row.user.emailVerifiedAt !== null,
    membershipStatus: row.status,
    blocked: row.blockedAt !== null,
    blockedAt: row.blockedAt?.toISOString(),
    blockedReason: row.blockedReason ?? undefined,
    source: row.source,
    joinedAt: row.joinedAt.toISOString(),
    lastActivityAt: row.lastActivityAt?.toISOString(),
    enrollmentCount: row.enrollmentCount,
    activeEnrollmentCount: row.activeEnrollmentCount,
  };
}

export interface RosterEnrollmentResponse {
  readonly id: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly courseSlug: string;
  readonly courseStatus: string;
  readonly status: string;
  readonly isActive: boolean;
  readonly accessSource: string;
  readonly enrolledAt?: string;
  readonly completedAt?: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  readonly revokeReason?: string;
  readonly progress?: {
    readonly completedLessons: number;
    readonly totalLessons: number;
    readonly percentage: number;
    readonly completionState: string;
    readonly certificateStatus: string;
  };
}

export function toRosterEnrollmentResponse(
  row: RosterEnrollmentRow,
  isActive: boolean,
): RosterEnrollmentResponse {
  return {
    id: row.id,
    courseId: row.courseId,
    courseTitle: row.course.title,
    courseSlug: row.course.slug,
    courseStatus: row.course.status,
    status: row.status,
    isActive,
    accessSource: row.accessSource,
    enrolledAt: row.enrolledAt?.toISOString(),
    completedAt: row.completedAt?.toISOString(),
    expiresAt: row.expiresAt?.toISOString(),
    revokedAt: row.revokedAt?.toISOString(),
    revokeReason: row.revokeReason ?? undefined,
    progress: row.progress
      ? {
          completedLessons: row.progress.completedLessons,
          totalLessons: row.progress.totalLessons,
          percentage: Number(row.progress.percentage),
          completionState: row.progress.completionState,
          certificateStatus: row.progress.certificateStatus,
        }
      : undefined,
  };
}

export interface RosterQuizOutcomeResponse {
  readonly attemptId: string;
  readonly quizId: string;
  readonly quizTitle: string;
  readonly courseId: string;
  readonly attemptNumber: number;
  readonly status: string;
  readonly score: number | null;
  readonly passed: boolean | null;
  readonly submittedAt: string | null;
}

export interface RosterAssignmentOutcomeResponse {
  readonly submissionId: string;
  readonly assignmentId: string;
  readonly assignmentTitle: string;
  readonly courseId: string;
  readonly status: string;
  readonly gradingStatus: string;
  readonly score: number | null;
  readonly hasFeedback: boolean;
  readonly submittedAt: string | null;
  readonly gradedAt: string | null;
}

export interface AcademyRosterStudentDetailResponse {
  readonly student: AcademyRosterStudentResponse;
  readonly enrollments: readonly RosterEnrollmentResponse[];
  readonly quizOutcomes: readonly RosterQuizOutcomeResponse[];
  readonly assignmentOutcomes: readonly RosterAssignmentOutcomeResponse[];
  readonly activeSessionCount: number;
  /** `instructor` viewers see only the courses they teach; the rest see the whole academy. */
  readonly viewerScope: 'academy' | 'assigned_courses';
}

export interface AcademyInviteResponse {
  readonly id: string;
  readonly academyId: string;
  readonly email?: string;
  readonly maxUses: number;
  readonly usedCount: number;
  readonly expiresAt: string;
  readonly revokedAt?: string;
  readonly createdAt: string;
  /** Present ONLY on the create response — the raw token is never stored. */
  readonly token?: string;
}

export function toAcademyInviteResponse(
  row: AcademyInvite,
  token?: string,
): AcademyInviteResponse {
  return {
    id: row.id,
    academyId: row.academyId,
    email: row.email ?? undefined,
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    token,
  };
}

export interface AcademyRegistrationPolicyResponse {
  readonly academyId: string;
  readonly registrationPolicy: 'open' | 'invite' | 'approval';
}
