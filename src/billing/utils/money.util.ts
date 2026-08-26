/**
 * Money conversion — the one place a catalog `PlanPricingMetadata`/
 * `AddOnPricingMetadata`'s display-unit `amount` (`money.types.ts`'s own
 * "documented 2-decimal-exponent assumption" — the same one `formatMoney`
 * encodes on the frontend) is converted into the integer minor-unit
 * `Money` shape `CheckoutSnapshot.price`/`Payment.amountMinorUnits` require.
 * Never done ad hoc inline — a single, tested seam to extend if a future
 * currency needs a different exponent (mirrors `formatMoney`'s own doc
 * comment verbatim).
 */
export function toMinorUnits(displayAmount: number): bigint {
  return BigInt(Math.round(displayAmount * 100));
}
