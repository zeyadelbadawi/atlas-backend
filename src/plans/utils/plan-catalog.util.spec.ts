/**
 * The six commercial variants (P64 Phase 2 — D5, D10; DL-17, DL-24).
 *
 * WHAT THIS PROTECTS. Three writers put these rows into a database and
 * one deletes rows that are not in this table: `prisma/seed.ts`,
 * `20261009000200_p64_phase2_premium_plans/migration.sql`, and
 * `scripts/cleanup-plan-catalog.ts`. The SQL cannot import TypeScript, so
 * the migration necessarily RESTATES these values — which makes the
 * catalog the one place where a silent disagreement would show up as a
 * customer on a plan whose entitlements differ depending on whether their
 * database was seeded or migrated.
 *
 * These are unit tests on purpose: the six variants are a property of the
 * catalog table, not of any database's contents, and asserting them here
 * pins them without depending on which fixture rows a database happens to
 * hold.
 */
import {
  PLAN_CATALOG,
  PLAN_CATALOG_KEYS,
  PLAN_CATALOG_VARIANTS,
  PLAN_FAMILIES,
  PLAN_TIERS,
  PLAN_TIER_BASELINE_VIDEO_STORAGE_MINUTES,
  planKeyFor,
} from './plan-catalog.util';

describe('plan catalog — the six commercial variants (D10)', () => {
  it('is exactly two families × three tiers', () => {
    expect(PLAN_FAMILIES).toEqual(['normal', 'premium']);
    expect(PLAN_TIERS).toEqual(['basic', 'growth', 'enterprise']);
    expect(PLAN_CATALOG_VARIANTS).toHaveLength(6);
  });

  it('resolves a DISTINCT plan key for every variant', () => {
    // Two variants sharing a key would collapse two products into one row
    // — `plans.key` is unique, so the second seed/migration would silently
    // become a no-op and a customer would be sold the wrong entitlements.
    expect(new Set(PLAN_CATALOG_KEYS).size).toBe(PLAN_CATALOG_VARIANTS.length);
  });

  it.each([
    ['normal', 'basic', 'starter'],
    ['normal', 'growth', 'growth'],
    ['normal', 'enterprise', 'enterprise'],
    ['premium', 'basic', 'premium-starter'],
    ['premium', 'growth', 'premium-growth'],
    ['premium', 'enterprise', 'premium-enterprise'],
  ] as const)('maps (%s, %s) to the plan key %s', (family, tier, key) => {
    expect(planKeyFor(family, tier)).toBe(key);
  });

  it('never renames the three keys that already exist (DL-17)', () => {
    // `starter` IS the `basic` tier. Renaming it would break every
    // `tenant_subscriptions` row referencing it, for no product benefit.
    expect(planKeyFor('normal', 'basic')).toBe('starter');
    expect(PLAN_CATALOG_KEYS).toEqual(
      expect.arrayContaining(['starter', 'growth', 'enterprise']),
    );
  });

  it('keeps every variant self-describing — its own family and tier', () => {
    for (const family of PLAN_FAMILIES) {
      for (const tier of PLAN_TIERS) {
        expect(PLAN_CATALOG[family][tier]).toMatchObject({ family, tier });
      }
    }
  });

  it('orders Normal 1–3 then Premium 4–6, with no duplicate display order', () => {
    expect(PLAN_CATALOG_VARIANTS.map((variant) => variant.displayOrder)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it('keeps `displayOrder` above zero so every variant is customer-facing', () => {
    // `PlansRepository.CUSTOMER_FACING_WHERE` filters on
    // `displayOrder > 0`. A variant seeded at 0 would exist, be
    // subscribable by key, and be invisible on the Plans page.
    for (const variant of PLAN_CATALOG_VARIANTS) {
      expect(variant.displayOrder).toBeGreaterThan(0);
    }
  });
});

describe('plan catalog — the video storage baseline (D5)', () => {
  it('holds D5’s approved baseline per tier', () => {
    expect(PLAN_TIER_BASELINE_VIDEO_STORAGE_MINUTES).toEqual({
      basic: 500,
      growth: 2000,
      enterprise: 5000,
    });
  });

  it.each(PLAN_TIERS)(
    'gives BOTH families the same baseline minutes on the %s tier',
    (tier) => {
      // D5 as amended makes the quota provider- and tier-independent so a
      // customer can compare a Normal and a Premium variant of the same
      // tier minute for minute. D5 PERMITS per-variant values and DL-24
      // records that as an open owner decision — so this assertion is
      // what says "nobody has taken that decision yet", and it is meant
      // to be updated by whoever implements a ruling, never quietly.
      expect(PLAN_CATALOG.premium[tier].videoStorageMinutes).toBe(
        PLAN_CATALOG.normal[tier].videoStorageMinutes,
      );
      expect(PLAN_CATALOG.normal[tier].videoStorageMinutes).toBe(
        PLAN_TIER_BASELINE_VIDEO_STORAGE_MINUTES[tier],
      );
    },
  );

  it('bounds every variant with a real number, never an unlimited quota', () => {
    // Provider-hosted minutes are the one resource with a real external
    // cost behind them, so D5 sets a ceiling for every tier — Enterprise
    // included, where every other limit is `unlimited`.
    for (const variant of PLAN_CATALOG_VARIANTS) {
      expect(typeof variant.videoStorageMinutes).toBe('number');
      expect(variant.videoStorageMinutes).toBeGreaterThan(0);
    }
  });
});

describe('plan catalog — no pricing in logic (D5, D10)', () => {
  it('carries no price on any variant', () => {
    // Prices are business data on the catalog ROW, changeable without a
    // deploy, and no provider price may appear in this codebase at all.
    // A price reachable from application code is the failure mode this
    // asserts against.
    for (const variant of PLAN_CATALOG_VARIANTS) {
      expect(Object.keys(variant).sort()).toEqual([
        'displayOrder',
        'family',
        'key',
        'tier',
        'videoStorageMinutes',
      ]);
    }
  });
});
