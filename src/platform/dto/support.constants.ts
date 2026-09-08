/** Mirrors `SupportCaseStatus` (atlas frontend `support.types.ts`) exactly — the standard, universally-understood support-ticket lifecycle, never an invented workflow. */
export const SUPPORT_CASE_STATUSES = [
  'open',
  'in_progress',
  'resolved',
  'closed',
] as const;

export const MAX_SUPPORT_REPLY_BODY_LENGTH = 5000;

/** Phase 8 — tenant-facing `POST .../support-cases` (create). */
export const MAX_SUPPORT_SUBJECT_LENGTH = 200;
export const MAX_SUPPORT_DESCRIPTION_LENGTH = 5000;
