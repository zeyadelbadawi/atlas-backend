/**
 * Effective-commission resolution — the pure, DB-free implementation of
 * §4.2's rule, extended (Phase P13, this session's product direction) from
 * a two-tier to a THREE-tier hierarchy: "Organization override → Plan
 * commission → Platform default." No silent fourth fallback. Kept as a
 * pure function (no Prisma/NestJS dependency) so it is directly
 * unit-testable against every combination of override mode, plan-tier
 * presence, and global-default presence, exactly matching this codebase's
 * "money/business-rule logic as a pure, tested function" precedent
 * (`money.util.ts`, `commission-math.util.ts`, `quiz-scoring.util.ts`).
 *
 * Precedence, precisely:
 *   1. `commissionMode === 'exempt'` → 0%, source `'exempt'` — an
 *      Organization-level decision, always wins outright.
 *   2. `commissionMode === 'custom'` → the Organization's own percentage,
 *      source `'custom'` — also always wins outright.
 *   3. Otherwise (`commissionMode` is `'default'`, or the Organization has
 *      no row at all — treated identically, matching the pre-P13
 *      "undefined mode ≡ explicit default row" rule) — fall through to the
 *      Organization's subscribed Plan's own commission override, if one is
 *      configured (`planCommissionBasisPoints !== null`), source `'plan'`.
 *   4. Otherwise, fall through to the platform-wide global default, if one
 *      is configured, source `'default'`.
 *   5. Otherwise, `resolved: false` — never a fabricated 0%.
 */
import type { OrganizationCommissionMode } from '@prisma/client';
import type { EffectiveCommissionResolution } from '../dto/commission.contract';

export function resolveEffectiveCommission(
  /** `undefined` when the Organization has never had a row written — treated identically to an explicit `'default'` row, matching every other lazy-default table in this feature. */
  commissionMode: OrganizationCommissionMode | undefined,
  customPercentageBasisPoints: number | null | undefined,
  /** The Organization's subscribed Plan's own commission override — `null` when the Plan has none configured, or the Organization has no active subscription/plan to resolve one from. */
  planCommissionBasisPoints: number | null,
  globalDefaultCommissionBasisPoints: number | null,
): EffectiveCommissionResolution {
  const mode = commissionMode ?? 'default';

  if (mode === 'exempt') {
    return { resolved: true, basisPoints: 0, source: 'exempt' };
  }

  if (mode === 'custom') {
    // Defensive: a `custom` row with no percentage is a data-integrity
    // problem the write path should have prevented — treated as
    // unresolved (fail closed) rather than silently guessing a value.
    if (customPercentageBasisPoints == null) return { resolved: false };
    return { resolved: true, basisPoints: customPercentageBasisPoints, source: 'custom' };
  }

  // mode === 'default' — fall through the remaining two tiers, in order.
  if (planCommissionBasisPoints != null) {
    return { resolved: true, basisPoints: planCommissionBasisPoints, source: 'plan' };
  }

  if (globalDefaultCommissionBasisPoints == null) return { resolved: false };
  return {
    resolved: true,
    basisPoints: globalDefaultCommissionBasisPoints,
    source: 'default',
  };
}
