/**
 * W3-compose — the vocabulary shared by both senders of a person-authored
 * message: the Platform Owner (scope `platform`) and an academy's owner or
 * administrator (scope `academy`).
 *
 * An audience is a TYPED predicate, never raw SQL and never a list of
 * user ids from the client: every recipient is resolved server-side from
 * the predicate, inside the sender's own scope, so a client cannot target
 * anyone the predicate does not reach.
 */
import type { AcademyMemberRole, TenantSubscriptionStatus } from '@prisma/client';

export type CampaignScope = 'platform' | 'academy';

/** The catalogue key each scope's outbox rows carry. */
export const CAMPAIGN_KEY = {
  platform: 'platform.broadcast.sent',
  academy: 'academy.message.sent',
} as const;

/** The preference category a recipient opts out of with the unsubscribe link. */
export const CAMPAIGN_PREFERENCE_CATEGORY = {
  platform: 'operational',
  academy: 'engagement',
} as const satisfies Record<CampaignScope, 'operational' | 'engagement'>;

export type UnsubscribeCategory = 'engagement' | 'operational';

export interface CampaignChannels {
  readonly email: boolean;
  readonly inApp: boolean;
}

// ---- platform audiences ------------------------------------------------------

export type PlatformAudience =
  /** Every active organization's owner. */
  | { readonly type: 'org_owners' }
  /** Active academy owners, optionally narrowed by plan and/or status. */
  | {
      readonly type: 'academy_owners';
      readonly planKeys?: readonly string[];
      readonly subscriptionStatuses?: readonly TenantSubscriptionStatus[];
      readonly academyStatuses?: readonly ('draft' | 'active' | 'suspended')[];
    }
  /** Every active academy owner and administrator. */
  | { readonly type: 'academy_owners_admins' }
  /** One organization: its members plus its academies' owners and administrators. */
  | { readonly type: 'organization'; readonly organizationId: string };

// ---- academy audiences -------------------------------------------------------

export type AcademyAudience =
  /** Active, unblocked learners of the academy. */
  | { readonly type: 'learners' }
  /** Active, unblocked learners enrolled (or completed) in any of these courses. */
  | { readonly type: 'courses'; readonly courseIds: readonly string[] }
  /** Active academy staff holding one of these roles. */
  | { readonly type: 'staff'; readonly roles: readonly AcademyMemberRole[] };

export type CampaignAudience = PlatformAudience | AcademyAudience;

// ---- limits ------------------------------------------------------------------

export const CAMPAIGN_SUBJECT_MAX = 150;
/** Raw editor HTML accepted on the wire (before sanitising). */
export const CAMPAIGN_BODY_HTML_MAX = 20_000;
/** Visible text after sanitising — what the reader actually gets. */
export const CAMPAIGN_BODY_TEXT_MAX = 5_000;
/** Recipients written / released per transaction — the announcement fan-out's precedent. */
export const CAMPAIGN_BATCH_SIZE = 200;
/** Recipients released per worker run before yielding (backpressure on the outbox). */
export const CAMPAIGN_RELEASE_PER_RUN = 2_000;
/** Audiences at or above this size need an explicit confirmation. */
export const CAMPAIGN_LARGE_AUDIENCE = 1_000;
/** In-app excerpt length: the feed shows a summary, not a document. */
export const CAMPAIGN_IN_APP_EXCERPT_MAX = 280;
/** The default academy monthly email allowance when a plan does not set one. */
export const DEFAULT_MONTHLY_EMAILS = 50;
export const MAX_COURSE_FILTER = 50;
export const MAX_PLAN_FILTER = 20;

/** Sends allowed per window, per sender scope. */
export const CAMPAIGN_SEND_RATE = {
  academy: { max: 10, windowSeconds: 60 * 60 },
  platform: { max: 20, windowSeconds: 60 * 60 },
} as const;
export const CAMPAIGN_PREVIEW_RATE = { max: 60, windowSeconds: 60 } as const;

// ---- wire shapes -------------------------------------------------------------

export interface CampaignQuotaView {
  /** null = unlimited. */
  readonly limit: number | null;
  readonly used: number;
  /** null = unlimited. */
  readonly remaining: number | null;
  readonly periodStart: string;
  /** Exclusive end of the calendar month (UTC) — when the counter resets. */
  readonly resetsAt: string;
}

export interface CampaignPreviewResponse {
  /** People the message reaches (in-app and/or email). */
  readonly recipientCount: number;
  /** Emails that would be queued (and charged, for an academy). */
  readonly emailCount: number;
  /** In-app notifications that would be written. */
  readonly inAppCount: number;
  readonly excluded: {
    readonly optedOut: number;
    readonly suppressed: number;
    /** Learners not reached because they are blocked (academy, learner audiences). */
    readonly blocked: number;
    /** Learners not reached because their membership is pending approval. */
    readonly pending: number;
  };
  readonly requiresConfirmation: boolean;
  /** Academy only; null for platform campaigns (never counted). */
  readonly quota: CampaignQuotaView | null;
  /** How many emails exceed the remaining quota (0 when it fits). */
  readonly overBy: number;
}

export interface CampaignProgressView {
  /** Emails still waiting in the outbox (pending or deferred). */
  readonly queued: number;
  /** Emails a provider accepted. */
  readonly sent: number;
  /** Emails the dispatcher settled without sending (preference, suppression, cap). */
  readonly skipped: number;
  /** Emails that terminally failed. */
  readonly failed: number;
  /** Delivered / bounced, as reported by provider webhooks. */
  readonly delivered: number;
  readonly bounced: number;
  /** In-app notifications written. */
  readonly inApp: number;
  /** Recipients not yet released by the worker. */
  readonly awaitingRelease: number;
}

export interface CampaignSummaryResponse {
  readonly id: string;
  readonly scope: CampaignScope;
  readonly status: string;
  readonly subject: string;
  readonly channels: CampaignChannels;
  readonly audience: CampaignAudience;
  readonly recipientCount: number;
  readonly expectedEmailCount: number;
  readonly excluded: {
    readonly optedOut: number;
    readonly suppressed: number;
    readonly quota: number;
  };
  readonly progress: CampaignProgressView;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly authorName: string | null;
}

export interface CampaignAcceptedResponse {
  readonly campaignId: string;
  readonly status: string;
  readonly recipientCount: number;
  readonly emailCount: number;
  readonly inAppCount: number;
  /** True when this response replays an earlier request with the same idempotency key. */
  readonly replayed: boolean;
  readonly quota: CampaignQuotaView | null;
}
