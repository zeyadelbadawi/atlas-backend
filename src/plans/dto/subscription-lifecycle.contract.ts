/**
 * `GET /organizations/:id/subscription/lifecycle` — THE single answer to
 * "where is this customer in the Atlas lifecycle, and what should they do
 * next?" (Phase 11).
 *
 * WHY AN ENDPOINT RATHER THAN LETTING THE FRONTEND DERIVE IT. It already
 * did, and that was the problem. `useSubscriptionAccess` reimplemented the
 * backend's status interpretation — the same INACTIVE_STATUSES set, the
 * same live trial-clock check — and the two had to be kept in step by
 * hand. They agreed, faithfully, including on the thing they were both
 * wrong about: that a brand-new Organization was an expired subscriber.
 * Deriving it once, server-side, means the sidebar, the dashboard, the
 * route guards and the banners cannot disagree with each other or with
 * the API that will actually refuse the writes.
 *
 * IT IS NOT AN AUTHORIZATION MECHANISM. Nothing is granted by what this
 * returns; every mutation is still refused independently by
 * `SubscriptionAccessInterceptor` and `EntitlementEnforcementService`, and
 * RLS underneath both. This exists so the UI can tell the truth BEFORE the
 * customer types into a form that was always going to be rejected.
 */
import type { PlanResponse } from './plan.contract';
import type { SubscriptionLifecycle } from '../services/subscription-access.service';

export interface SubscriptionLifecycleResponse {
  /** The authoritative state. The frontend switches on this and derives nothing. */
  readonly lifecycle: SubscriptionLifecycle;
  /** True when gated product areas may be used at all. */
  readonly hasAccess: boolean;
  /** The raw subscription status, for display and debugging. */
  readonly status?: string;
  /**
   * The plan this state refers to — the one being trialed, the one
   * subscribed to, or the one whose trial just ended (which is what makes
   * "Continue with Growth" possible). Absent in `no_plan`, where the
   * `plan_id` on the row is a NOT-NULL placeholder and must never be
   * presented to the customer as a plan they have.
   */
  readonly plan?: PlanResponse;
  readonly trialEndsAt?: string;
  /** Whole days left in an active trial. 0 on the final day, never negative. */
  readonly trialDaysRemaining?: number;
  readonly currentPeriodEnd?: string;
  /**
   * Whether this ACCOUNT may still redeem its one lifetime Free Trial.
   *
   * DISPLAY ONLY, and deliberately named so. `TrialEligibilityService`
   * refuses to expose a check-then-grant pair precisely because a caller
   * would eventually enforce on it; the real decision is made atomically
   * inside `claimTrial` at the moment of redemption. This value exists so
   * the Plans page can show "Try free for 3 days" rather than offering a
   * trial that will be refused.
   */
  readonly trialAvailable: boolean;
}
