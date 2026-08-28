/**
 * Small, pure helpers shared by every P16 aggregation — kept separate and
 * dependency-free specifically so they're unit-testable without a
 * database (master plan §12: "unit tests for pure analytics calculations
 * where appropriate").
 */

/**
 * `((current - previous) / previous) * 100`, rounded to 2 decimals —
 * `undefined` whenever `previous` is `0` (never a divide-by-zero, never a
 * fabricated `Infinity`/`-100`-that-isn't-really-meaningful). Matches
 * every `changePercent`/`engagementRateChangePercent` field's own
 * `readonly ... ?: number` optionality — the frontend already renders
 * "no trend" correctly when this is omitted (`trendFor` in both
 * `AnalyticsPage.tsx`/`PlatformDashboardPage.tsx` returns `undefined` for
 * an `undefined` input).
 */
export function safeChangePercent(current: number, previous: number): number | undefined {
  if (previous === 0) return undefined;
  return Math.round(((current - previous) / previous) * 100 * 100) / 100;
}

/** `numerator / denominator * 100`, clamped to `[0, 100]`, `0` when `denominator` is `0` — every `*Percent` field in this phase (`engagementRatePercent`, `storageUsagePercent`) is a real `0–100` value by contract, never `NaN`/negative/over 100. */
export function safeRatePercent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  const value = (numerator / denominator) * 100;
  return Math.round(Math.min(100, Math.max(0, value)) * 100) / 100;
}

/** Minor units (integer) → a plain decimal number, matching every other money-response boundary in this codebase (`course.contract.ts`'s own documented "DB stores minor units, response DTOs convert to a decimal" convention). */
export function minorUnitsToDecimal(minorUnits: bigint | number): number {
  return Number(minorUnits) / 100;
}
