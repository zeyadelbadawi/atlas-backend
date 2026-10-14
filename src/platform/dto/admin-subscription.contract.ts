/**
 * Admin subscription/trial operations contract.
 *
 * Every field is a real aggregate. Revenue (B0-ANL-01) is derived from
 * approved subscription payments only — never from plan list prices — and
 * says how many active periods have no approved payment behind them.
 */

/** One currency's monthly recurring revenue. Never summed across currencies. */
export interface AdminRecurringRevenueRow {
  readonly currency: string;
  /** Sum of each counted period's latest approved plan payment; yearly payments ÷ 12. */
  readonly monthlyAmountMinorUnits: number;
  readonly subscriptions: number;
}

export type AdminBillingCycleKey = 'monthly' | 'yearly' | 'none';

export interface AdminCancellationRow {
  readonly id: string;
  readonly kind: 'trial' | 'paid';
  readonly reason: string;
  /** Absent when the user chose not to elaborate — never required to cancel. */
  readonly feedback?: string;
  readonly cancelledAt: string;
  readonly effectiveAt: string;
  readonly organizationId: string;
  readonly organizationName: string;
  /** Attribution only. Deliberately no email address — the view needs to know who acted, not how to contact them. */
  readonly cancelledByUserId?: string;
  readonly cancelledByName?: string;
}

export interface AdminPlanDistributionRow {
  readonly planId: string;
  readonly planKey: string;
  readonly planName: string;
  readonly subscriptions: number;
}

export interface AdminSubscriptionOverview {
  readonly organizations: number;

  readonly subscriptions: {
    /** Raw count per `TenantSubscriptionStatus`. Absent keys mean zero rows in that state. */
    readonly byStatus: Record<string, number>;
    /** `active` + `past_due` + `grace_period` — every state where a paid subscription still exists. */
    readonly activePaid: number;
    /** B0-ANL-01 — status × billing cycle (`none` = no cycle recorded, e.g. trials). */
    readonly byStatusAndCycle: Record<string, Record<AdminBillingCycleKey, number>>;
  };

  readonly trials: {
    /** Every trial ever redeemed, including those whose organization was later deleted. */
    readonly everRedeemed: number;
    /** Trials live right now: still `trialing` and not yet past `trialEndsAt`. */
    readonly active: number;
    readonly cancelled: number;
    /** Point-in-time derivation, not a stored funnel — see the service's own doc comment. */
    readonly convertedToPaid: number;
  };

  readonly cancellations: {
    readonly trials: number;
    readonly paid: number;
    /** Reason code -> count, over the closed vocabulary in `CANCELLATION_REASONS`. */
    readonly byReason: Record<string, number>;
    readonly recent: readonly AdminCancellationRow[];
  };

  /** Top plans by subscription count — bounded, see `PLAN_DISTRIBUTION_LIMIT`. */
  readonly plans: readonly AdminPlanDistributionRow[];
  /** How many plans carry a subscription in total, including any not listed above. */
  readonly totalPlansWithSubscriptions: number;

  /**
   * B0-ANL-01 — monthly recurring revenue from APPROVED subscription
   * payments: for every `active` subscription whose period has not ended,
   * its latest approved plan payment, yearly payments divided by 12, per
   * currency. Never derived from plan list prices. Periods with no approved
   * plan payment (granted or extended by the platform, migrated) are
   * counted in `activeWithoutPayment`, not valued.
   *
   * Organizations the Platform Owner marked internal (test, demo, staff —
   * B0-ANL-04) are left out of `mrr`, `activeSubscriptions` and
   * `activeWithoutPayment`.
   */
  readonly revenue: {
    readonly tracked: true;
    readonly mrr: readonly AdminRecurringRevenueRow[];
    readonly activeSubscriptions: number;
    readonly activeWithoutPayment: number;
    readonly excludesInternalOrganizations: true;
  };

  readonly generatedAt: string;
}
