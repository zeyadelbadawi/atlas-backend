/**
 * Student Learning validation constants — matches `atlas frontend/src/
 * features/learning/constants/learning.constants.ts` exactly.
 */
export const MAX_ASSIGNMENT_RESPONSE_LENGTH = 5000;

/** `enrollments.status` values that grant real access to a course's content — matches every RLS policy's `e."status" IN (...)` clause exactly. Never trust a caller-supplied enrollment id; every service re-derives this from the authenticated student's own row. */
export const ACTIVE_ENROLLMENT_STATUSES = ['enrolled', 'completed'] as const;

/** Phase 4 (P24) — Quiz/Assignment authoring validation constants. Mirrors `course.constants.ts`'s own length-ceiling convention exactly. */
export const MAX_QUIZ_TITLE_LENGTH = 150;
export const MAX_QUIZ_DESCRIPTION_LENGTH = 2000;
export const MAX_QUIZ_QUESTION_PROMPT_LENGTH = 1000;
export const MAX_QUIZ_OPTION_LABEL_LENGTH = 300;
/** At least one question — an empty quiz is never a real, takeable quiz. */
export const MIN_QUIZ_QUESTIONS = 1;
/** A generous sanity ceiling, not a real product limit — guards against a malformed/abusive payload, never expected to bind a legitimate author. */
export const MAX_QUIZ_QUESTIONS = 100;
export const MAX_QUIZ_OPTIONS_PER_QUESTION = 10;

export const MAX_ASSIGNMENT_TITLE_LENGTH = 150;
export const MAX_ASSIGNMENT_DESCRIPTION_LENGTH = 2000;
export const MAX_ASSIGNMENT_INSTRUCTIONS_LENGTH = 5000;
