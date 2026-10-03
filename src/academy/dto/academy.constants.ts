/** Kept in sync with `AcademyStatus` (atlas frontend `academy.types.ts`). */
export const ACADEMY_STATUS_VALUES = [
  'draft',
  'active',
  'suspended',
  'archived',
] as const;

/**
 * The lifecycle values an Academy's own owner or manager may set through
 * `PATCH /academies/:id` (Task 1). `draft` and `active` gate nothing —
 * public availability is the website's publish state — so they stay
 * settable for compatibility. `suspended` is a platform action, and
 * `archived` goes only through `DELETE /academies/:id`, which also records
 * `archivedAt`, drops the public hostname cache and releases usage; a PATCH
 * that set either would take the site and academy sign-in offline while
 * skipping those side effects.
 */
export const TENANT_SETTABLE_ACADEMY_STATUS_VALUES = ['draft', 'active'] as const;
