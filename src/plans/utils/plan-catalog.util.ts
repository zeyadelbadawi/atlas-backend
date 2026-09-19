/**
 * The six commercial plan variants (master plan D10, D5; DL-17, DL-24).
 *
 * TWO AXES, NOT SIX PLANS. Atlas sells two plan FAMILIES (`normal`,
 * `premium`) across three TIERS (`basic`, `growth`, `enterprise`). The
 * FAMILY decides the video security capability class and nothing else; the
 * TIER decides commercial limits and features and nothing else. Modelling
 * them as two independent axes is what keeps six variants from becoming
 * six copies of the same rule set — `VideoTierService` reads only the
 * family, and every limit/feature reader reads only the tier's numbers.
 *
 * WHY THE KEYS ARE NOT `NORMAL_BASIC`-SHAPED. `plans.key` is the identity
 * every `tenant_subscriptions` row already references, and D10's variant
 * NAMES are product vocabulary, not database keys. Renaming `starter` to
 * `normal_basic` would rewrite live subscription rows for no product
 * benefit, so the seeded keys stay exactly as they are (DL-17) and this
 * table is what translates between the two vocabularies: `starter` IS
 * `(normal, basic)`.
 *
 * WHY THIS TABLE EXISTS AT ALL — THREE READERS THAT MUST AGREE.
 *   1. `prisma/seed.ts` writes these rows into a fresh local database.
 *   2. `20261009000200_p64_phase2_premium_plans` writes the same rows into
 *      a database that already exists (production runs `prisma migrate
 *      deploy` and nothing else, so a row living only in the seed never
 *      reaches a customer — exactly the defect the P45b add-on catalog
 *      migration was written to fix).
 *   3. `scripts/cleanup-plan-catalog.ts` decides which `plans` rows are
 *      real and which are accumulated e2e fixtures. A key missing from
 *      here would be DELETED by that script along with its subscriptions.
 * A literal list in three places is a list that will disagree in two of
 * them. The SQL necessarily restates the values (a migration cannot
 * import TypeScript), and its own header says so.
 *
 * NO PRICES HERE, DELIBERATELY (D5, D10). Price is business data that
 * lives on the catalog ROW, changeable by the Platform Owner without a
 * deploy. Nothing in this file — or anywhere else in application logic —
 * may depend on an amount, and no provider price appears in this codebase
 * at all.
 */
import type { PlanFamily, PlanTier } from '@prisma/client';

/** Every `PlanFamily`, for iteration — mirrors `PLAN_LIMIT_KEYS`'s own precedent in `entitlement.types.ts`. */
export const PLAN_FAMILIES: readonly PlanFamily[] = ['normal', 'premium'];

/** Every `PlanTier`, in commercial order (this one IS the display order). */
export const PLAN_TIERS: readonly PlanTier[] = ['basic', 'growth', 'enterprise'];

/**
 * The baseline `videoStorageMinutes` entitlement per TIER (D5, DL-3).
 *
 * Keyed by tier alone because the baseline is deliberately family-
 * independent: D5 as amended makes the quota provider- and tier-
 * independent so a customer can compare a Normal and a Premium variant of
 * the same tier directly, minute for minute.
 *
 * D5 PERMITS per-variant values later (`NORMAL_BASIC` ≠ `PREMIUM_BASIC`)
 * and DL-24 records that as an OPEN owner decision. The mechanism that
 * would support it is `PlanCatalogVariant.videoStorageMinutes` below —
 * one value per variant, already — so honouring a future decision is a
 * data change here, not a schema or code change. Until the owner rules,
 * inventing a difference would be inventing a product decision.
 *
 * An Atlas entitlement, never a provider billing value.
 */
export const PLAN_TIER_BASELINE_VIDEO_STORAGE_MINUTES: Readonly<Record<PlanTier, number>> = {
  basic: 500,
  growth: 2_000,
  enterprise: 5_000,
};

/** One commercial variant — the translation between D10's `(family, tier)` vocabulary and the `plans.key` the database has always used. */
export interface PlanCatalogVariant {
  readonly family: PlanFamily;
  readonly tier: PlanTier;
  /** `plans.key` — the stable identity `tenant_subscriptions` references. Never renamed (DL-17). */
  readonly key: string;
  /** `plans.display_order` — Normal 1–3 then Premium 4–6, so the catalog page reads family by family. */
  readonly displayOrder: number;
  /** The variant's `videoStorageMinutes` entitlement (D5). */
  readonly videoStorageMinutes: number;
}

/**
 * The catalog, indexed by both axes.
 *
 * A total `Record` rather than a list plus a lookup that can miss: every
 * `(family, tier)` pair is a real product, so `PLAN_CATALOG[family][tier]`
 * needs no "not found" branch and no test can be written for one.
 */
export const PLAN_CATALOG: Readonly<
  Record<PlanFamily, Readonly<Record<PlanTier, PlanCatalogVariant>>>
> = {
  normal: {
    basic: {
      family: 'normal',
      tier: 'basic',
      // D10's `basic` tier. The seeded key has said `starter` since P4 and
      // stays that way (DL-17) — the tier column is what carries D10's
      // vocabulary now.
      key: 'starter',
      displayOrder: 1,
      videoStorageMinutes: PLAN_TIER_BASELINE_VIDEO_STORAGE_MINUTES.basic,
    },
    growth: {
      family: 'normal',
      tier: 'growth',
      key: 'growth',
      displayOrder: 2,
      videoStorageMinutes: PLAN_TIER_BASELINE_VIDEO_STORAGE_MINUTES.growth,
    },
    enterprise: {
      family: 'normal',
      tier: 'enterprise',
      key: 'enterprise',
      displayOrder: 3,
      videoStorageMinutes: PLAN_TIER_BASELINE_VIDEO_STORAGE_MINUTES.enterprise,
    },
  },
  premium: {
    basic: {
      family: 'premium',
      tier: 'basic',
      key: 'premium-starter',
      displayOrder: 4,
      videoStorageMinutes: PLAN_TIER_BASELINE_VIDEO_STORAGE_MINUTES.basic,
    },
    growth: {
      family: 'premium',
      tier: 'growth',
      key: 'premium-growth',
      displayOrder: 5,
      videoStorageMinutes: PLAN_TIER_BASELINE_VIDEO_STORAGE_MINUTES.growth,
    },
    enterprise: {
      family: 'premium',
      tier: 'enterprise',
      key: 'premium-enterprise',
      displayOrder: 6,
      videoStorageMinutes: PLAN_TIER_BASELINE_VIDEO_STORAGE_MINUTES.enterprise,
    },
  },
};

/**
 * All six variants, flattened in display order.
 *
 * DERIVED from `PLAN_CATALOG` rather than written out a second time —
 * a hand-maintained parallel list is precisely the drift this file exists
 * to prevent.
 */
export const PLAN_CATALOG_VARIANTS: readonly PlanCatalogVariant[] = PLAN_FAMILIES.flatMap(
  (family) => PLAN_TIERS.map((tier) => PLAN_CATALOG[family][tier]),
);

/**
 * The `plans.key` of every real, catalog-defined plan.
 *
 * Used by `scripts/cleanup-plan-catalog.ts` to tell a real plan from an
 * accumulated e2e fixture row. Anything not listed here is deletable, so
 * this list is load-bearing for data safety, not just for display.
 */
export const PLAN_CATALOG_KEYS: readonly string[] = PLAN_CATALOG_VARIANTS.map(
  (variant) => variant.key,
);

/** The `plans.key` for a `(family, tier)` pair — D10's vocabulary translated into the database's. */
export function planKeyFor(family: PlanFamily, tier: PlanTier): string {
  return PLAN_CATALOG[family][tier].key;
}

/**
 * Every plan key that offers a given TIER, across both families.
 *
 * Exists because add-on compatibility is a TIER question, not a family
 * one (D10: "the plan tier determines the commercial limits and
 * features"). Before the Premium family existed, `compatiblePlanKeys`
 * could simply list `['growth']` and mean "the Growth tier"; with six
 * variants that same list silently means "the Normal Growth variant
 * only", and a paying `premium-growth` customer is refused an add-on
 * their tier includes.
 *
 * Deriving the list rather than writing it out twice is what stops the
 * two families drifting apart the next time a tier is added.
 */
export function planKeysForTiers(tiers: readonly PlanTier[]): string[] {
  return PLAN_FAMILIES.flatMap((family) => tiers.map((tier) => PLAN_CATALOG[family][tier].key));
}
