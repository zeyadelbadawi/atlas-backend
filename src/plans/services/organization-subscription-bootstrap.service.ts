/**
 * OrganizationSubscriptionBootstrapService — Phase 2 (Decision 6). Gives
 * every brand-new Organization a REAL, immediate `'trialing'` subscription
 * — the roadmap's own acceptance criterion verbatim: "A brand-new
 * Organization automatically receives a 3-day, no-card trial with a real,
 * enforced expiry — no manual step required."
 *
 * Called from `OrganizationsController`'s (this module's own, relocated
 * from `TenancyModule` — see this module's own doc comment) `create`
 * handler, via `OrganizationsService.create`'s new `onCreated` hook
 * parameter — takes the already-open `Prisma.TransactionClient` from that
 * SAME transaction, so the organization, its owner membership, and its
 * trial subscription are created atomically: a request that fails
 * partway through can never leave an Organization with no subscription at
 * all, and never needs a second HTTP round-trip.
 *
 * Uses the EXISTING `TrialPolicyRepository`/`TrialPolicy` architecture
 * (master plan §21 Phase P4) — never a second, parallel "how long is a
 * trial" concept — and the lowest-tier active Plan as the trial-tier Plan
 * (see `PlansRepository.findDefaultTrialPlan`'s own doc comment for why:
 * this schema has no separate "trial plan" catalog entry, a trial is a
 * subscription STATUS, not a different Plan).
 */
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TrialPolicyRepository } from '../repositories/trial-policy.repository';
import { PlansRepository } from '../repositories/plans.repository';
import { TenantSubscriptionsRepository } from '../repositories/tenant-subscriptions.repository';
import { TrialEligibilityService } from './trial-eligibility.service';
import type { TrialClaimContext } from './trial-eligibility.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class OrganizationSubscriptionBootstrapService {
  private readonly logger = new Logger(OrganizationSubscriptionBootstrapService.name);

  constructor(
    private readonly trialPolicyRepository: TrialPolicyRepository,
    private readonly plansRepository: PlansRepository,
    private readonly tenantSubscriptionsRepository: TenantSubscriptionsRepository,
    private readonly trialEligibilityService: TrialEligibilityService,
  ) {}

  /**
   * @param ownerUserId  The creating user. Their email is the trial
   *                     SUBJECT (see `TrialEligibilityService`) and is
   *                     read here, through the caller's own `tx`, rather
   *                     than accepted from the caller — the subject of a
   *                     trial claim must come from the database, never
   *                     from anything a request could influence.
   */
  async bootstrapTrialSubscription(
    tx: Prisma.TransactionClient,
    organizationId: string,
    ownerUserId: string,
    context?: TrialClaimContext,
  ): Promise<void> {
    const [trialPolicy, plan] = await Promise.all([
      this.trialPolicyRepository.findSingleton(),
      this.plansRepository.findDefaultTrialPlan(),
    ]);

    if (!plan) {
      // No active Plan exists at all — a genuinely broken platform
      // configuration (an empty `plans` catalog), not a per-organization
      // edge case any caller could have avoided. Fails the whole
      // Organization-creation transaction loudly rather than silently
      // leaving a subscription-less Organization behind, which would
      // just re-surface as the pre-existing "honest 404 no subscription"
      // state everywhere downstream instead of at the one point it is
      // actually actionable.
      this.logger.error('No active Plan exists — cannot bootstrap a trial subscription.');
      throw new InternalServerErrorException({
        messageKey: 'errors.entitlement.noPlanAvailable',
      });
    }

    // Decision 6 (locked): exactly `trialPolicy.durationDays` (3 by
    // default — see `TrialPolicyRepository`'s own doc comment) from NOW,
    // real wall-clock time, never a placeholder. `enabled: false` (a
    // Platform Owner has switched trials off entirely) still creates a
    // subscription — just `status: 'trialing'` with a
    // ZERO-day-effectively-already-elapsed window is the wrong shape;
    // instead an org created while trials are disabled gets a
    // `trialEndsAt` of right now, so the very next entitlement check
    // (`isTrialPeriodOver`) correctly treats it as already expired rather
    // than this service inventing a second "no trial" status this schema
    // does not have.
    const durationDays = trialPolicy.enabled ? trialPolicy.durationDays : 0;
    const requestedTrialEndsAt = new Date(Date.now() + durationDays * MS_PER_DAY);

    // Phase 10.1 — the trial is no longer unconditional. Claiming it is
    // an atomic INSERT against a UNIQUE index inside THIS transaction, so
    // a concurrent second organization-creation for the same subject
    // cannot also win, and a later failure in this transaction rolls the
    // redemption back rather than burning the user's one trial.
    const owner = await tx.user.findUniqueOrThrow({
      where: { id: ownerUserId },
      select: { id: true, email: true },
    });

    const claim = await this.trialEligibilityService.claimTrial(tx, {
      email: owner.email,
      organizationId,
      userId: owner.id,
      trialEndsAt: requestedTrialEndsAt,
      context,
    });

    // A refused claim still creates the subscription — it just creates it
    // ALREADY EXPIRED, by reusing the exact `trialEndsAt = now` shape
    // this service already produces when a Platform Owner has switched
    // trials off. That reuse is deliberate: `isTrialPeriodOver` and every
    // downstream entitlement check already handle it correctly, so no new
    // subscription status has to be invented and no existing consumer has
    // to learn about a second "no trial" concept. The organization is
    // created normally; it simply has no usable trial.
    const trialEndsAt = claim.granted ? requestedTrialEndsAt : new Date();

    if (!claim.granted) {
      this.logger.log(
        { organizationId, reason: claim.reason },
        'Organization created without a Free Trial — the subject has already redeemed one.',
      );
    }

    await this.tenantSubscriptionsRepository.create(tx, {
      organizationId,
      planId: plan.id,
      trialEndsAt,
    });
  }
}
