/**
 * Effective-commission resolution — the pure, DB-free implementation of
 * master plan §4.2's rule: "Organization override → global default → no
 * effective rate." No silent third fallback. Kept as a pure function
 * (no Prisma/NestJS dependency) so it is directly unit-testable against
 * every combination of override mode and global-default presence, exactly
 * matching this codebase's "money/business-rule logic as a pure, tested
 * function" precedent (`money.util.ts`, `commission-math.util.ts`,
 * `quiz-scoring.util.ts`).
 */
import type { OrganizationCommissionMode } from '@prisma/client';
import type { EffectiveCommissionResolution } from '../dto/commission.contract';

export function resolveEffectiveCommission(
  /** `undefined` when the Organization has never had a row written — treated identically to an explicit `'default'` row, matching every other lazy-default table in this feature. */
  commissionMode: OrganizationCommissionMode | undefined,
  customPercentageBasisPoints: number | null | undefined,
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

  // mode === 'default'
  if (globalDefaultCommissionBasisPoints == null) return { resolved: false };
  return {
    resolved: true,
    basisPoints: globalDefaultCommissionBasisPoints,
    source: 'default',
  };
}
