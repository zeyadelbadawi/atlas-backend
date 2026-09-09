/**
 * Admin subscription/trial operations contract.
 *
 * Every field is a real aggregate. Where Atlas does not track something,
 * the contract says so explicitly (`revenue.tracked: false`) rather than
 * offering a zero that a reader would reasonably mistake for a measured
 * value — the same honest shape the tenant dashboard already uses.
 */

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

  readonly plans: readonly AdminPlanDistributionRow[];

  /**
   * Atlas does not track subscription revenue: plan prices are catalog
   * metadata and no ledger ties a subscription to money received.
   * Reported as untracked rather than derived from list prices, which
   * would be a fabricated figure presented as a measurement.
   */
  readonly revenue: { readonly tracked: false };

  readonly generatedAt: string;
}
