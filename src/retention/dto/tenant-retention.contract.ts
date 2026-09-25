/**
 * The shape of `GET /organizations/:id/retention` — P64 Communications
 * C6's CUSTOMER-FACING half, the page `/dashboard/tenant/retention` that
 * every W1-W4 warning email links to (`TENANT_RETENTION_PATH` in the
 * communication catalog).
 *
 * WHY THIS CONTRACT LOOKS THE WAY IT DOES. A retention warning makes an
 * academy owner ask exactly four questions, and a page that cannot answer
 * all four is worse than no page at all, because it confirms the fear
 * without resolving it:
 *
 *   WHAT will be deleted   -> `video` (count, stored minutes, bytes) and
 *                             `courses` (which of their courses lose video).
 *   WHEN                   -> `anchorAt`, `deletionAt`, `daysUntilDeletion`,
 *                             and `warnings[]` as a dated timeline.
 *   WHY                    -> `origin` ('trial' = 90 days, 'paid' = 180)
 *                             plus `windowDays`, so the rule is stated,
 *                             not merely applied.
 *   HOW DO I STOP IT       -> `state` and `hold`: whether the clock is
 *                             running at all, and `mode`, which says
 *                             whether ANYTHING is actually scheduled yet.
 *
 * `mode` IS PART OF THE TRUTH, NOT AN IMPLEMENTATION LEAK. While
 * `FLAG_VIDEO_RETENTION_MODE` is `off` the sweep returns before it
 * evaluates anyone, so no date on this page is going to be acted on by
 * anything. A page that showed a deletion date without saying so would be
 * telling a customer their content is at risk when it provably is not —
 * the exact class of lie this workstream exists to prevent. It carries no
 * cross-tenant information: it is one platform-wide operating mode, and
 * it is the single fact that decides whether the rest of this payload is
 * a schedule or a projection.
 *
 * READ-ONLY. Nothing here decides anything. Every field is derived from
 * `video-retention.util.ts`'s own evaluator and from rows the deletion
 * path already writes; this contract adds no rule of its own, so it
 * cannot disagree with the sweep about when a deletion happens.
 */
import type { VideoRetentionMode } from '../../config/configuration';
import type { RetentionOrigin, RetentionStepId } from '../utils/video-retention.util';

/**
 * What this organisation's hosted video is actually facing, in one word.
 *
 * Computed on the SERVER so the page and the sweep cannot form different
 * opinions from the same numbers. Precedence is deliberate and is ordered
 * by what the customer most needs to know first.
 */
export type TenantRetentionState =
  /** No retention window is open — the subscription is live, or was never inactive long enough. */
  | 'not_scheduled'
  /** A window is open, a date exists, and no warning has gone out yet. */
  | 'scheduled'
  /** A window is open and at least one of W1-W4 has actually been sent. */
  | 'warning'
  /** A legal hold or an open support case is freezing the clock. */
  | 'held'
  /** The deletion date has passed (the work is due, running, or was missed). */
  | 'elapsed';

/** Why the clock is frozen. Deliberately a closed set — see the service. */
export type TenantRetentionHoldReason = 'legal_hold' | 'support_case';

/** One row of the W1 -> W2 -> W3 -> W4 timeline. */
export interface TenantRetentionWarningStep {
  readonly step: RetentionStepId;
  /** When this warning falls (or fell) due. ISO 8601. */
  readonly dueAt: string;
  /**
   * Whether an outbox row for THIS anchor exists — the same evidence
   * guard (2) uses to authorise a deletion, so the timeline the customer
   * reads is the timeline the deletion path believes in.
   */
  readonly sent: boolean;
}

/** One course that would lose hosted video. */
export interface TenantRetentionCourse {
  readonly id: string;
  readonly title: string;
  readonly videoCount: number;
  readonly storedMinutes: number;
}

export interface TenantRetentionVideoTally {
  readonly assetCount: number;
  readonly storedMinutes: number;
  /** BigInt, serialised as a decimal string — `JSON.stringify` cannot carry one. */
  readonly storedBytes: string;
  /**
   * Hosted videos this organisation has ALREADY lost to retention
   * (tombstoned rows). Always present, and `0` is the answer the page
   * needs most: "nothing has been deleted" must be a fact the UI reads,
   * never an assumption it makes.
   */
  readonly deletedAssetCount: number;
  /** The most recent retention deletion, or `null` when there has never been one. */
  readonly lastDeletedAt: string | null;
}

export interface TenantRetentionResponse {
  readonly organizationId: string;
  readonly state: TenantRetentionState;
  /** The platform's current retention mode. `off` means nothing is scheduled anywhere. */
  readonly mode: VideoRetentionMode;
  readonly windowOpen: boolean;
  /** 'trial' -> 90 days, 'paid' -> 180 days. `null` when no window is open. */
  readonly origin: RetentionOrigin | null;
  readonly windowDays: number | null;
  /** The immutable instant the whole sequence is measured from. ISO 8601. */
  readonly anchorAt: string | null;
  readonly deletionAt: string | null;
  /** Whole days from now until `deletionAt`; `0` on the final day, never negative. */
  readonly daysUntilDeletion: number | null;
  /** Empty when no window is open. */
  readonly warnings: readonly TenantRetentionWarningStep[];
  readonly hold: {
    readonly held: boolean;
    readonly reason: TenantRetentionHoldReason | null;
  };
  readonly video: TenantRetentionVideoTally;
  readonly courses: readonly TenantRetentionCourse[];
  /** True when `courses` was capped — the page says so rather than quietly lying. */
  readonly coursesTruncated: boolean;
  readonly generatedAt: string;
}
