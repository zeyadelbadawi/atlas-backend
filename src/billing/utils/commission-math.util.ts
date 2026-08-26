/**
 * Commission arithmetic — the one place a basis-points percentage is ever
 * applied to a minor-unit money amount (master plan §4.2: "every commission
 * ... calculation is integer arithmetic on minor currency units only...
 * floating-point arithmetic is never used"). `bigint` throughout, matching
 * `Payment.amountMinorUnits`'s own type — never `Number`, which cannot
 * represent every minor-unit amount exactly once it exceeds 2^53.
 *
 * Rounding rule: deterministic round-half-up, per §4.2 — the same rounded
 * value is reproducible from the same inputs every time, never a locale- or
 * runtime-dependent float rounding. Basis points range 0–10000 (0%–100%),
 * matching `custom_percentage_basis_points`'s own documented range.
 *
 * Scope note: this file intentionally stops at applying a rate to an
 * amount. The proportional refund-reversal ledger entry §4.2 describes is
 * Course Commerce (P13) territory — there is no `payments`/ledger row to
 * apply it to yet in this phase (see this task's own scope boundary) — and
 * is not implemented here.
 */

const BASIS_POINTS_DENOMINATOR = 10000n;

/**
 * `amountMinorUnits * basisPoints / 10000`, rounded half-up. Both inputs
 * are assumed non-negative — every caller of this function only ever
 * applies it to a non-negative sale amount.
 */
export function applyBasisPoints(amountMinorUnits: bigint, basisPoints: number): bigint {
  const numerator = amountMinorUnits * BigInt(basisPoints);
  const quotient = numerator / BASIS_POINTS_DENOMINATOR;
  const remainder = numerator % BASIS_POINTS_DENOMINATOR;
  // Round half up: a remainder of exactly half the denominator (or more) rounds the quotient up.
  return remainder * 2n >= BASIS_POINTS_DENOMINATOR ? quotient + 1n : quotient;
}
