/**
 * `AcademyActivity` response contract — matches `academy.types.ts` exactly.
 *
 * No table backs this yet: no activity/event log exists anywhere in this
 * backend (`audit_log_entries` is Platform Owner Control Plane scope,
 * unbuilt; no domain event in P0–P3 writes to any kind of activity feed).
 * `GET /academies/:id/activity` is therefore a real endpoint that honestly
 * returns an empty page today, not a fake/hardcoded response masking an
 * error — there genuinely is no activity data yet, and the pagination
 * envelope is real. This is `SPECIFICATION-UNDEFINED`: which domain events
 * feed this endpoint (member joins? branding changes? course publishes?)
 * has never been specified. Documented for a future phase, not guessed at
 * here.
 */
export interface AcademyActivityResponse {
  readonly id: string;
  readonly academyId: string;
  readonly type: string;
  readonly description: string;
  readonly userId?: string;
  readonly userName?: string;
  readonly timestamp: string;
}
