/**
 * Student Learning validation constants — matches `atlas frontend/src/
 * features/learning/constants/learning.constants.ts` exactly.
 */
export const MAX_ASSIGNMENT_RESPONSE_LENGTH = 5000;

/** `enrollments.status` values that grant real access to a course's content — matches every RLS policy's `e."status" IN (...)` clause exactly. Never trust a caller-supplied enrollment id; every service re-derives this from the authenticated student's own row. */
export const ACTIVE_ENROLLMENT_STATUSES = ['enrolled', 'completed'] as const;
