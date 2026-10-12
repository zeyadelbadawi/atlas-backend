/**
 * CF-23 / B0-BIL-02 — the two rules that decide whether an organization may
 * take an add-on without going through a paid checkout.
 *
 * WHY THIS EXISTS. `POST /organizations/:id/add-ons/:key/install` used to
 * check only the billing permission and `catalogStatus === 'published'`
 * before activating the add-on, so a priced add-on (e.g. `extra-academy`)
 * could be installed for free with one request. Unpublishing it in the
 * console is a configuration control one wrong click undoes; these rules
 * make the API itself refuse.
 *
 * - A **priced** add-on comes into existence only through the purchase path
 *   (checkout → proof → approval → `PaymentApplicationService` calls
 *   `TenantAddOnsRepository.activate`). The lifecycle `install` route is for
 *   free add-ons only.
 * - `compatiblePlanKeys` was stored but only ever used for upgrade advice.
 *   An empty list means "compatible with every plan" (how every add-on
 *   without a restriction was seeded); a non-empty list must contain the
 *   organization's current plan key.
 */

/** True when the add-on's catalog pricing carries a positive amount. */
export function isPricedAddOn(pricing: unknown): boolean {
  if (!pricing || typeof pricing !== 'object') return false;
  const amount = (pricing as { amount?: unknown }).amount;
  const numeric = typeof amount === 'string' ? Number(amount) : amount;
  return typeof numeric === 'number' && Number.isFinite(numeric) && numeric > 0;
}

/**
 * True when `planKey` may use an add-on restricted to `compatiblePlanKeys`.
 * An organization with no subscription (no plan key) is compatible only with
 * unrestricted add-ons.
 */
export function isPlanCompatibleWithAddOn(
  compatiblePlanKeys: readonly string[] | null | undefined,
  planKey: string | null | undefined,
): boolean {
  if (!compatiblePlanKeys || compatiblePlanKeys.length === 0) return true;
  return !!planKey && compatiblePlanKeys.includes(planKey);
}
