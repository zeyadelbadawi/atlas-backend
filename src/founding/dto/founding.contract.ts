/**
 * B2 — Founding Academies: Platform Owner response shapes. Matched
 * field-for-field by the frontend's `PlatformFoundingService` types.
 */
export interface FoundingMoney {
  readonly amount: number;
  readonly currency: string;
}

export interface FoundingPlanRef {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly nameLocalized?: { readonly en?: string; readonly ar?: string };
}

export interface FoundingSubscriptionRef {
  readonly status: string;
  readonly billingCycle?: 'monthly' | 'yearly';
  readonly planKey: string;
  readonly planName: string;
  readonly currentPeriodEnd?: string;
  readonly cancelAtPeriodEnd: boolean;
}

/** What the next renewal would be charged, decided by the same rule as checkout. */
export interface FoundingNextRenewal {
  readonly amount: number;
  readonly currency: string;
  /** `true` when it is the founding locked price, `false` for the catalog price. */
  readonly locked: boolean;
  /** When that renewal period would start. */
  readonly periodStartsAt: string;
}

export interface FoundingMembershipSummary {
  readonly id: string;
  readonly seatNumber: number;
  readonly status: 'active' | 'revoked' | 'ended';
  readonly organization: { readonly id: string; readonly name: string };
  readonly owner: { readonly name: string; readonly email: string };
  readonly plan: FoundingPlanRef;
  readonly lockedPrice: FoundingMoney;
  readonly lockStartsAt: string;
  readonly lockEndsAt: string;
  readonly subscription?: FoundingSubscriptionRef;
  readonly nextRenewal?: FoundingNextRenewal;
  readonly conciergeHoursUsed: number;
  readonly conciergeHoursCap: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FoundingTimelineEntry {
  readonly id: string;
  readonly action: string;
  readonly occurredAt: string;
  readonly actorName?: string;
  readonly context: Readonly<Record<string, unknown>>;
}

export interface FoundingMembershipDetail extends FoundingMembershipSummary {
  readonly owner: {
    readonly name: string;
    readonly email: string;
    /** Present only when the owner opted in to WhatsApp contact (B0-IAM-08). */
    readonly phone?: string;
  };
  readonly notes?: string;
  readonly revokedAt?: string;
  readonly revokedReason?: string;
  readonly sourceContact?: {
    readonly id: string;
    readonly name: string;
    readonly email: string;
    readonly organizationName?: string;
    readonly status: string;
    readonly createdAt: string;
  };
  readonly timeline: readonly FoundingTimelineEntry[];
}

export interface FoundingSeatSummary {
  readonly seatCap: number;
  readonly seatsTaken: number;
  readonly seatsAvailable: number;
  /** Memberships created since Monday 00:00 (Africa/Cairo) this week. */
  readonly onboardedThisWeek: number;
  readonly weeklyTarget: number;
  readonly weekStartsAt: string;
  readonly counts: {
    readonly active: number;
    readonly ended: number;
    readonly revoked: number;
  };
}

export interface FoundingQuote {
  readonly organization: { readonly id: string; readonly name: string };
  readonly owner: { readonly name: string; readonly email: string };
  readonly plan: FoundingPlanRef;
  /** The plan's current annual catalog price: the price that will be locked. */
  readonly lockedPrice: FoundingMoney;
  /** The seat the membership would take now, or `null` when all 20 are taken. */
  readonly nextSeatNumber: number | null;
  readonly alreadyMember: boolean;
  readonly subscription?: FoundingSubscriptionRef;
}

export interface FoundingCandidate {
  readonly id: string;
  readonly name: string;
  readonly ownerName: string;
  readonly ownerEmail: string;
  readonly subscription?: FoundingSubscriptionRef;
}

export interface FoundingEligiblePlan extends FoundingPlanRef {
  readonly annualPrice: FoundingMoney;
}

export interface FoundingEmailPreview {
  readonly recipientCount: number;
  readonly recipients: readonly {
    readonly membershipId: string;
    readonly seatNumber: number;
    readonly organizationName: string;
    readonly ownerName: string;
  }[];
  /**
   * The primary email provider's daily budget for this message's category
   * (lifecycle line, 85 %): what is left today. `null` when the provider
   * has no daily cap. Anything over it is deferred to the next day by the
   * existing quota, never dropped.
   */
  readonly quota: {
    readonly provider: string;
    readonly dailyLimit: number;
    readonly dailyUsed: number;
    readonly remainingToday: number;
  } | null;
}

export interface FoundingEmailSendResult {
  readonly sendId: string;
  readonly queued: number;
}
