/**
 * Which `plans` rows the catalog cleanup script (`scripts/cleanup-plan-catalog.ts`)
 * may delete.
 *
 * The script exists to clear e2e fixture plans out of a shared database.
 * It used to delete every plan whose key was not one of the catalog's real
 * keys, because plans had no write endpoint, so anything else was by
 * definition a fixture. That stopped being true when the Platform Owner
 * console gained "New plan" (`POST /platform-plans`): a plan created
 * there is real, and deleting it would also delete its customers'
 * subscriptions. A plan is therefore KEPT when any of these holds:
 *
 * - its key is a catalog key (`PLAN_CATALOG_KEYS`);
 * - it was created through the console (a `plan.created` audit entry
 *   names it);
 * - an organization subscribed to it has ever had a payment;
 * - a Founding Academy membership is locked to it.
 *
 * Only a plan with none of those is a fixture and is removed.
 */
export interface PlanCleanupCandidate {
  readonly id: string;
  readonly key: string;
}

export interface PlanCleanupEvidence {
  /** `targetId` of every `plan.created` audit entry. */
  readonly consoleCreatedPlanIds: ReadonlySet<string>;
  /** Plans with a subscription whose organization has a payment row. */
  readonly planIdsWithPayments: ReadonlySet<string>;
  /** Plans a Founding Academy membership points at. */
  readonly planIdsWithFoundingMemberships: ReadonlySet<string>;
}

export type PlanKeepReason =
  'catalog' | 'console-created' | 'has-payments' | 'founding-lock';

export interface PlanCleanupSelection {
  readonly remove: readonly PlanCleanupCandidate[];
  readonly keep: readonly {
    readonly plan: PlanCleanupCandidate;
    readonly reason: PlanKeepReason;
  }[];
}

/** First reason a plan must be kept, or `null` when it is a removable fixture. */
export function planKeepReason(
  plan: PlanCleanupCandidate,
  catalogKeys: readonly string[],
  evidence: PlanCleanupEvidence,
): PlanKeepReason | null {
  if (catalogKeys.includes(plan.key)) return 'catalog';
  if (evidence.consoleCreatedPlanIds.has(plan.id)) return 'console-created';
  if (evidence.planIdsWithPayments.has(plan.id)) return 'has-payments';
  if (evidence.planIdsWithFoundingMemberships.has(plan.id)) return 'founding-lock';
  return null;
}

export function selectRemovablePlans(
  plans: readonly PlanCleanupCandidate[],
  catalogKeys: readonly string[],
  evidence: PlanCleanupEvidence,
): PlanCleanupSelection {
  const remove: PlanCleanupCandidate[] = [];
  const keep: { plan: PlanCleanupCandidate; reason: PlanKeepReason }[] = [];
  for (const plan of plans) {
    const reason = planKeepReason(plan, catalogKeys, evidence);
    if (reason === null) remove.push(plan);
    else keep.push({ plan, reason });
  }
  return { remove, keep };
}
