/**
 * Pure progress-computation helpers shared by `EnrollmentsService`
 * (initial materialization) and `CourseProgressService` (recomputation on
 * lesson completion) — kept as pure functions so the exact same rule
 * applies at both call sites, never re-derived twice.
 */
import type { CertificateStatus, CourseCompletionState } from '@prisma/client';

/**
 * A course with zero published lessons is deliberately `incomplete`, not
 * `completed` — a trivial 0-of-0 "completion" would show a nonsensical
 * "course complete" congratulations for a course with no actual content.
 */
export function deriveCompletionState(
  completedLessons: number,
  totalLessons: number,
): CourseCompletionState {
  if (totalLessons > 0 && completedLessons === totalLessons) return 'completed';
  if (completedLessons > 0) return 'in_progress';
  return 'incomplete';
}

/**
 * Certificate generation itself is explicitly out of scope (master plan
 * §21 P6: "Must NOT implement yet: certificates (SPECIFICATION-UNDEFINED,
 * §24)") — this only ever reports the honest, already-real completion
 * fact through the field the frontend already has, never a fabricated
 * certificate artifact.
 */
export function deriveCertificateStatus(
  completionState: CourseCompletionState,
): CertificateStatus {
  return completionState === 'completed' ? 'eligible' : 'unavailable';
}
