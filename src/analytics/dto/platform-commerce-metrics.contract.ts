/**
 * `GET /platform-metrics/commerce?days=` — the Platform Owner's checkout /
 * approval / refund view (P64 Phase 4 §E.5). Until now these numbers only
 * existed as Prometheus series (`LearningMetricsService`); this is the
 * product surface for them. A SEPARATE response from the fixed seven-KPI
 * `PlatformMetricsOverviewResponse`, whose contract forbids new fields.
 *
 * Counts and minor-unit sums only — no emails, names, ids of any kind.
 *
 * Scope: Course Commerce (P13) only — `course_orders`, the `payments` rows
 * attached to a course order (`course_order_id IS NOT NULL`), their
 * proofs/reviews, and `course_order_refunds`. Atlas Subscription Billing
 * payments (P12, `checkout_id`) are NOT counted here.
 *
 * Window: `[now - windowDays, now]`. Which timestamp each block is
 * windowed on is stated per field, because they differ on purpose.
 */

export interface PlatformCommerceOrderCountsResponse {
  /** Orders whose `created_at` falls inside the window — the sum of the six status buckets below. */
  readonly created: number;
  /** ...of which are CURRENTLY in each `CourseOrderStatus`. `draft` is the enum's default state before checkout starts. */
  readonly draft: number;
  readonly pendingPayment: number;
  readonly paid: number;
  readonly expired: number;
  readonly refunded: number;
  readonly cancelled: number;
}

export interface PlatformCommercePaymentCountsResponse {
  /** ALL-TIME backlog: course-order payments with `review_status = pending` right now, regardless of age. */
  readonly awaitingReview: number;
  /** `payment_reviews` decisions with `status = approved` and `reviewed_at` inside the window. */
  readonly approvedInWindow: number;
  /** `payment_reviews` decisions with `status = rejected` and `reviewed_at` inside the window. */
  readonly rejectedInWindow: number;
}

export interface PlatformCommerceApprovalLatencyResponse {
  /** Median seconds from the latest `payment_proofs.uploaded_at` (at or before the decision) to `payment_reviews.reviewed_at`, over approvals in the window. `null` when `sampleSize` is 0. */
  readonly p50: number | null;
  /** 95th percentile of the same distribution. `null` when `sampleSize` is 0. */
  readonly p95: number | null;
  /** Approvals in the window that had a proof to measure from (an approval with no proof row contributes nothing). Capped at 50 000 most-recent decisions. */
  readonly sampleSize: number;
  /** True when the 50 000-row read cap was hit — the percentiles then describe only the most recent 50 000 approvals. */
  readonly truncated: boolean;
}

export interface PlatformCommerceRefundCountsResponse {
  /** `course_order_refunds` rows with `requested_at` inside the window, any status. */
  readonly requestedInWindow: number;
  /** ...with `status = succeeded` and `processed_at` inside the window. */
  readonly completedInWindow: number;
}

export interface PlatformCommerceRevenueResponse {
  /**
   * Sum of `snapshot.price.amountMinorUnits` over orders whose status is
   * CURRENTLY `paid` and whose `paid_at` is inside the window, keyed by
   * the snapshot's currency (an order later refunded is no longer `paid`
   * and drops out). Minor units (cents/piastres), never a decimal amount;
   * one key per currency, never a cross-currency total.
   */
  readonly paidByCurrency: Readonly<Record<string, number>>;
}

export interface PlatformCommerceMetricsResponse {
  /** The `days` the caller asked for (1–90, default 30). */
  readonly windowDays: number;
  readonly orders: PlatformCommerceOrderCountsResponse;
  readonly payments: PlatformCommercePaymentCountsResponse;
  readonly approvalLatencySeconds: PlatformCommerceApprovalLatencyResponse;
  readonly refunds: PlatformCommerceRefundCountsResponse;
  readonly revenue: PlatformCommerceRevenueResponse;
  readonly generatedAt: string;
}
