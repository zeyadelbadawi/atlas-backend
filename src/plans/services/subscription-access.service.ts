/**
 * Whether an Organization is currently entitled to USE Atlas at all.
 *
 * This is a different question from the one `EntitlementEnforcementService`
 * answers. That service asks "does this plan have room for one more
 * course?" — a limit. This one asks "is this tenant's subscription in a
 * state that permits administrative work?" — access. A tenant can be well
 * within every limit and still not be entitled to anything, because their
 * trial ran out last night.
 *
 * WHY IT IS A SEPARATE SERVICE AND NOT A SECOND COPY OF THE RULE. The
 * definition of "inactive" lives in exactly one place —
 * `SUBSCRIPTION_INACTIVE_STATUSES` plus `isTrialPeriodOver` — and both
 * services read it. A second, drifting definition is how a tenant ends up
 * blocked from creating a course but allowed to publish a website, which is
 * worse than either answer applied consistently.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: touch data. Expiry changes what a
 * tenant may DO, never what they have. No academy, course, student, page or
 * media asset is removed, hidden or altered by anything here — the brief's
 * rule and the right one commercially, because a customer who resubscribes
 * must find their work exactly where they left it.
 */
import { ForbiddenException, Injectable } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { TenantSubscriptionsRepository } from '../repositories/tenant-subscriptions.repository';
import { isTrialPeriodOver } from '../utils/trial.util';
import { PublicHostnameResolutionRepository } from '../../public-website/repositories/public-hostname-resolution.repository';

/**
 * Statuses with no entitlement to administrative access.
 *
 * `grace_period` is deliberately ABSENT: a grace period exists precisely so
 * that a tenant whose payment is late keeps working while it is sorted out,
 * and treating it as expired would defeat the feature Atlas already models.
 * `past_due` likewise — the subscription is still current, the invoice is
 * not. `paused` is absent for the same reason it is a distinct status:
 * pausing is a deliberate, reversible state the product offers, not a
 * failure.
 */
export const SUBSCRIPTION_INACTIVE_STATUSES: ReadonlySet<string> = new Set([
  'expired',
  'cancelled',
  // Phase 11. A finished trial genuinely ends administrative access, so it
  // belongs here beside the other two. `no_plan` deliberately does NOT —
  // it is a customer who has not started yet rather than one who has
  // stopped, and refusing their setup mutations would lock them out of the
  // onboarding that precedes ever paying (see `assertHasAccess`).
  'trial_expired',
]);

/** The one machine-readable code the frontend switches on to show the subscription-required experience. */
export const SUBSCRIPTION_REQUIRED_CODE = 'SUBSCRIPTION_REQUIRED';

/**
 * THE canonical lifecycle vocabulary (Phase 11) — one name per state the
 * product actually distinguishes, derived server-side and mirrored by the
 * frontend's `SubscriptionLifecycle` rather than re-derived there.
 *
 * `no_plan` and `trial_expired` and `expired` are three different
 * situations with three different recovery actions, and flattening them
 * is the bug this vocabulary exists to make impossible to reintroduce:
 *
 *   no_plan        -> "choose a plan to get started"   (new customer)
 *   trial_expired  -> "continue with <the plan you trialed>"
 *   expired        -> "your subscription has ended"    (was a payer)
 *   cancelled_active -> "your subscription ends on <date>" (still working)
 */
export type SubscriptionLifecycle =
  | 'no_organization'
  | 'no_plan'
  | 'trialing'
  | 'trial_expired'
  | 'active'
  | 'cancelled_active'
  | 'expired';

export interface SubscriptionAccessState {
  readonly hasAccess: boolean;
  /** The authoritative lifecycle state. Always present. */
  readonly lifecycle: SubscriptionLifecycle;
  /** Present when access is refused — what the UI explains to the customer. */
  readonly reason?: 'no_subscription' | 'no_plan' | 'expired' | 'trial_ended';
  readonly status?: string;
  readonly trialEndsAt?: Date | null;
  readonly currentPeriodEnd?: Date | null;
  /** Days left in an active trial — 0 on its final day, never negative. */
  readonly trialDaysRemaining?: number;
}

/** Statuses under which a real, working paid subscription exists. */
const LIVE_PAID_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'past_due',
  'grace_period',
  'paused',
]);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whole days left before `endsAt`, floored at 0.
 *
 * `Math.ceil` so that any part of a day still counts as a day: a trial
 * with six hours left says "1 day", never "0 days" while it is still
 * working. Already-past dates give 0 rather than a negative number, so no
 * caller has to guard against "-3 days left".
 */
function daysRemaining(endsAt: Date | null, now: Date): number {
  if (!endsAt) return 0;
  return Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / MS_PER_DAY));
}

@Injectable()
export class SubscriptionAccessService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly tenantSubscriptionsRepository: TenantSubscriptionsRepository,
    private readonly publicHostnameResolutionRepository: PublicHostnameResolutionRepository,
  ) {}

  /**
   * Whether this tenant's public websites should still be SERVED.
   *
   * The same "lapsed, not merely unsubscribed" rule `assertHasAccess`
   * applies, expressed once so the two can never drift into a state where
   * the dashboard says one thing and the public site does another.
   *
   * A tenant who has never subscribed keeps their site: they are
   * mid-onboarding, not lapsed, and taking a website off the internet is
   * the most visible thing this system can do to a customer. It is reserved
   * for the case where something that WAS paid for has ended.
   */
  async isServingEligible(organizationId: string): Promise<boolean> {
    const state = await this.getAccessState(organizationId);
    return (
      state.hasAccess || state.reason === 'no_subscription' || state.reason === 'no_plan'
    );
  }

  /**
   * The same assertion, for a caller that knows only an academy.
   *
   * Lives here rather than in the interceptor so that the interceptor
   * depends on one service instead of reaching for a repository of its own
   * — a global `APP_INTERCEPTOR` resolves in the root module's context, so
   * every dependency it names has to be exported all the way up, and each
   * one is a piece of this service's job leaking outward.
   *
   * Resolving an academy to its Organization is a read of OWNERSHIP, not of
   * authorisation: it decides whose subscription to consult, and the
   * handler's own authorisation still runs untouched afterwards.
   */
  async assertHasAccessForAcademy(academyId: string): Promise<void> {
    const organizationId =
      await this.publicHostnameResolutionRepository.resolveAcademyOrganization(academyId);
    // An unknown academy is the handler's 404 to give, not ours to convert
    // into a billing error.
    if (!organizationId) return;

    await this.assertHasAccess(organizationId);
  }

  /**
   * The authoritative read, computed live.
   *
   * `isTrialPeriodOver` is evaluated against the clock rather than trusting
   * `status` alone, because the sweep that flips `trialing` to `expired`
   * runs on a schedule: between a trial ending and the sweep noticing,
   * `status` still says `trialing` and is wrong. Enforcing on the date
   * closes that window instead of depending on a background job having run
   * — the same reasoning `EntitlementEnforcementService` already applies.
   */
  async getAccessState(organizationId: string): Promise<SubscriptionAccessState> {
    const subscription = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.tenantSubscriptionsRepository.findByOrganizationId(tx, organizationId),
    );

    const now = new Date();

    // No row at all. Still reachable for organizations created before the
    // bootstrap service existed, so it keeps its own honest answer rather
    // than being folded into `no_plan`.
    if (!subscription) {
      return { hasAccess: false, lifecycle: 'no_plan', reason: 'no_subscription' };
    }

    // A NEW CUSTOMER, NOT A LAPSED ONE. Checked before anything else so
    // that no later branch can reclassify it — this is precisely the
    // state that used to fall through into `expired`.
    if (subscription.status === 'no_plan') {
      return {
        hasAccess: false,
        lifecycle: 'no_plan',
        reason: 'no_plan',
        status: subscription.status,
      };
    }

    // Either the sweep has already flipped the row, or it has not yet and
    // the clock says otherwise. Both are the same answer to the customer,
    // and checking the clock as well is what closes the window between a
    // trial ending and the scheduled sweep noticing.
    if (subscription.status === 'trial_expired' || isTrialPeriodOver(subscription, now)) {
      return {
        hasAccess: false,
        lifecycle: 'trial_expired',
        reason: 'trial_ended',
        status: subscription.status,
        trialEndsAt: subscription.trialEndsAt,
      };
    }

    if (SUBSCRIPTION_INACTIVE_STATUSES.has(subscription.status)) {
      return {
        hasAccess: false,
        lifecycle: 'expired',
        reason: 'expired',
        status: subscription.status,
        trialEndsAt: subscription.trialEndsAt,
        currentPeriodEnd: subscription.currentPeriodEnd,
      };
    }

    if (subscription.status === 'trialing') {
      return {
        hasAccess: true,
        lifecycle: 'trialing',
        status: subscription.status,
        trialEndsAt: subscription.trialEndsAt,
        currentPeriodEnd: subscription.currentPeriodEnd,
        trialDaysRemaining: daysRemaining(subscription.trialEndsAt, now),
      };
    }

    // CANCELLED BUT STILL PAID FOR is not expired, and must not be shown
    // as such: the customer bought this time and keeps it until
    // `currentPeriodEnd`. The expiry sweep is what eventually ends it.
    const isCancelledButActive =
      subscription.cancelAtPeriodEnd && LIVE_PAID_STATUSES.has(subscription.status);

    return {
      hasAccess: true,
      lifecycle: isCancelledButActive ? 'cancelled_active' : 'active',
      status: subscription.status,
      trialEndsAt: subscription.trialEndsAt,
      currentPeriodEnd: subscription.currentPeriodEnd,
    };
  }

  /**
   * Refuses the request when the tenant's subscription has LAPSED.
   *
   * "NEVER SUBSCRIBED" IS NOT "LAPSED", and conflating them breaks
   * onboarding. Organization creation deliberately does not auto-start a
   * trial, so a brand-new customer legitimately has no `tenant_subscriptions`
   * row at all while they are still setting themselves up — configuring
   * payment collection, filling in their organization, choosing a plan.
   * Refusing every mutation for them would lock a customer out of the very
   * setup that precedes paying, which is the same closed loop the
   * billing/support allowlist exists to avoid.
   *
   * The writes that genuinely REQUIRE an entitlement to consume — creating
   * an academy, a course, an enrollment — are already refused for exactly
   * this case by `EntitlementEnforcementService`, with its own
   * `ENTITLEMENT_NO_SUBSCRIPTION` code. That is the right place for it:
   * those are limit decisions, and it knows which resources have limits.
   * This service answers the narrower question it is actually good at —
   * "did something that WAS working stop?" — and stays out of the other.
   *
   * `getAccessState` still reports `no_subscription` honestly, because the
   * dashboard genuinely wants to know; it simply is not grounds to refuse.
   *
   * 403 rather than 402: `402 Payment Required` is the semantically
   * appealing choice, but Atlas's error vocabulary maps it to `unknown`,
   * which would strip the response of the `kind` the frontend routes on.
   * The distinguishing signal is `code`, which is what every other
   * business-specific refusal in this codebase already uses.
   */
  async assertHasAccess(organizationId: string): Promise<void> {
    const state = await this.getAccessState(organizationId);
    if (state.hasAccess) return;
    // "Never subscribed" is not "lapsed" — see this method's doc comment.
    // `no_plan` is the modelled form of exactly that case since Phase 11;
    // `no_subscription` remains for rows predating the bootstrap service.
    if (state.reason === 'no_subscription' || state.reason === 'no_plan') return;

    throw new ForbiddenException({
      code: SUBSCRIPTION_REQUIRED_CODE,
      messageKey: 'errors.subscription.required',
      details: {
        reason: state.reason ?? 'expired',
        ...(state.status ? { status: state.status } : {}),
      },
    });
  }
}
