/**
 * Course Commerce constants (Phase P13, master plan §21/§23).
 *
 * `COURSE_ORDER_EXPIRY_MINUTES` mirrors `CHECKOUT_EXPIRY_MINUTES`'s own
 * precedent (`billing/dto/billing.constants.ts`) exactly — a reasonable,
 * narrow, documented default, not a value pulled from any specification.
 *
 * `REFUND_WINDOW_DAYS` is THE finalized product decision this session's
 * instructions state explicitly: "A student can request a full refund
 * within 30 days of the course purchase." A single named constant, not a
 * magic number inlined at each call site — the one place a future
 * Organization-specific or configurable refund window (explicitly flagged
 * as a desired future extension, not built now) would change, without
 * touching `CourseOrderRefundsService`'s own logic.
 */

/** How long a CourseOrder stays payable after creation before it is treated as expired — same rationale as `CHECKOUT_EXPIRY_MINUTES`. */
export const COURSE_ORDER_EXPIRY_MINUTES = 30;

/** The current, global, non-configurable full-refund eligibility window — see this file's own doc comment for why a future per-Organization policy is a real, anticipated extension point, not built in this phase. */
export const REFUND_WINDOW_DAYS = 30;

/**
 * Academy Manual Payments — how long an order stays payable once the
 * learner has chosen one of the academy's own manual methods, and again
 * after a rejection. A bank transfer or wallet payment is made outside
 * Atlas and can take a day or two to clear; 30 minutes is a checkout
 * window, not a transfer window. While a proof is waiting for review the
 * order never expires (expiry is only checked when a new payment starts).
 */
export const ACADEMY_MANUAL_PAYMENT_WINDOW_HOURS = 72;
