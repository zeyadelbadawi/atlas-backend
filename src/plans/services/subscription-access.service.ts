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
]);

/** The one machine-readable code the frontend switches on to show the subscription-required experience. */
export const SUBSCRIPTION_REQUIRED_CODE = 'SUBSCRIPTION_REQUIRED';

export interface SubscriptionAccessState {
  readonly hasAccess: boolean;
  /** Present when access is refused — what the UI explains to the customer. */
  readonly reason?: 'no_subscription' | 'expired' | 'trial_ended';
  readonly status?: string;
  readonly trialEndsAt?: Date | null;
  readonly currentPeriodEnd?: Date | null;
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
    return state.hasAccess || state.reason === 'no_subscription';
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

    if (!subscription) {
      return { hasAccess: false, reason: 'no_subscription' };
    }

    if (isTrialPeriodOver(subscription, new Date())) {
      return {
        hasAccess: false,
        reason: 'trial_ended',
        status: subscription.status,
        trialEndsAt: subscription.trialEndsAt,
      };
    }

    if (SUBSCRIPTION_INACTIVE_STATUSES.has(subscription.status)) {
      return {
        hasAccess: false,
        reason: 'expired',
        status: subscription.status,
        trialEndsAt: subscription.trialEndsAt,
        currentPeriodEnd: subscription.currentPeriodEnd,
      };
    }

    return {
      hasAccess: true,
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
    if (state.reason === 'no_subscription') return;

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
