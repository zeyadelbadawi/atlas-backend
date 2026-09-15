/**
 * Add-ons that are IMPLEMENTED but intentionally not yet open to customers.
 *
 * This is a controlled product-state switch, not a feature flag framework:
 * a small, single-purpose allow-list of add-on keys whose customer-facing
 * activation is deferred ("Coming Soon"). It exists because the `AddOn`
 * catalog has no availability column, and the product decision is to keep
 * the code shipped while blocking customer install/enable/use.
 *
 * Live Sessions is deferred pending EXTERNAL Zoom approvals (Anonymous Join
 * Exception + domain validation) — see `docs/live-sessions/LIVE_SESSIONS_STATUS.md`.
 * These are external blockers, not defects in this codebase.
 *
 * THIS IS ALSO THE KILL SWITCH / ROLLBACK. Removing a key from this set is
 * the single edit that re-opens the add-on to customers; adding one defers
 * it again. Enforced in two places, both of which consult this set:
 *   - `AddOnAccessService.describe` returns `coming_soon` (blocks every
 *     customer create/publish/join/provision path, even if a tenant somehow
 *     already has a row installed), and
 *   - `AddOnsLifecycleController` refuses install/enable at the API boundary.
 */
export const DEFERRED_ADD_ON_KEYS: ReadonlySet<string> = new Set(['live-sessions']);

/** Whether an add-on is deferred (customer activation blocked). */
export function isAddOnDeferred(addOnKey: string): boolean {
  return DEFERRED_ADD_ON_KEYS.has(addOnKey);
}
