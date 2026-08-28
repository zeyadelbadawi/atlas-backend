/**
 * Shared "pick the one dominant currency" reduction — every closed-shape
 * P16 response contract that carries a single money value (`AnalyticsOverview.
 * revenue`/`.revenueCurrency`, `PlatformMetricsOverview.revenue`) can only
 * report ONE number, so this is the one place that decision is made,
 * applied identically everywhere (never re-derived ad hoc per call site).
 * See `AnalyticsRevenueRepository`'s own doc comment for why this
 * limitation exists (no currency-conversion model anywhere in this
 * codebase) — 100% of real data today is `USD` (verified directly against
 * the dev database), so this never actually discards data in practice; it
 * exists purely as a safety net if a second currency is ever introduced.
 */
import { minorUnitsToDecimal } from './metric-math.util';

export interface CurrencyAmountLike {
  readonly currency: string;
  readonly amountMinorUnits: bigint;
}

/** Combines any number of `{currency, amountMinorUnits}` rows into per-currency totals, then reports the single largest one as a decimal — `{amount: 0, currency: 'USD'}` when there's no data at all (never `NaN`/`undefined`, matching the contract's non-optional `amount`/`currency` fields). */
export function pickDominantCurrencyAmount(
  rows: readonly CurrencyAmountLike[],
  fallbackCurrency = 'USD',
): { amount: number; currency: string } {
  const totals = sumByCurrency(rows);
  if (totals.size === 0) return { amount: 0, currency: fallbackCurrency };

  const [currency, amountMinorUnits] = [...totals.entries()].sort((a, b) =>
    b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0,
  )[0];
  return { amount: minorUnitsToDecimal(amountMinorUnits), currency };
}

export function sumByCurrency(rows: readonly CurrencyAmountLike[]): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const row of rows) {
    totals.set(row.currency, (totals.get(row.currency) ?? 0n) + row.amountMinorUnits);
  }
  return totals;
}
