/**
 * OrganizationSubscriptionBootstrapService — gives every brand-new
 * Organization a subscription ROW, and deliberately no trial.
 *
 * WHAT CHANGED IN PHASE 10.2, AND WHY. This service used to grant a real
 * `'trialing'` subscription automatically, implementing Phase 2's
 * Decision 6 ("a brand-new Organization automatically receives a 3-day,
 * no-card trial ... no manual step required"). That behaviour is now
 * explicitly superseded by the Phase 10.2 product flow: a trial is
 * something a user CHOOSES from the Plans page and confirms, not
 * something that happens to them for creating a workspace.
 *
 * Two problems made the old behaviour untenable:
 *
 *   1. ABUSE. Any authenticated user may create any number of
 *      Organizations, so an automatic per-Organization trial was an
 *      unlimited trial generator. Confirmed against the running
 *      application: three trials in under a second from one account.
 *   2. PRODUCT. A trial silently burned on workspace creation means the
 *      user spends their one trial before they have chosen a plan or
 *      seen what they are trialling.
 *
 * WHAT A NEW ORGANIZATION GETS INSTEAD: a subscription row with
 * `status: 'expired'` and `trialEndsAt: null`. That is not a new concept
 * — `expired` is already in `INACTIVE_STATUSES`
 * (`entitlement-enforcement.service.ts`), so every existing entitlement
 * check already treats it correctly as "no usable entitlement" without
 * any change. Creating the row up front (rather than leaving the
 * organization subscription-less) preserves the original reason this
 * service exists: downstream code can rely on a subscription always
 * being present, and never has to special-case a missing one.
 *
 * Trials are now redeemed exclusively by `TrialRedemptionService.startTrial`.
 */
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PlansRepository } from '../repositories/plans.repository';
import { TenantSubscriptionsRepository } from '../repositories/tenant-subscriptions.repository';

@Injectable()
export class OrganizationSubscriptionBootstrapService {
  private readonly logger = new Logger(OrganizationSubscriptionBootstrapService.name);

  constructor(
    private readonly plansRepository: PlansRepository,
    private readonly tenantSubscriptionsRepository: TenantSubscriptionsRepository,
  ) {}

  /**
   * Creates the Organization's initial, inactive subscription row inside
   * the caller's existing transaction.
   *
   * Grants NO trial. Nothing in this method reads or writes
   * `trial_redemptions`, so creating Organizations — one or a thousand —
   * cannot consume or restore trial eligibility.
   */
  async bootstrapSubscription(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<void> {
    const plan = await this.plansRepository.findDefaultTrialPlan();

    if (!plan) {
      // No active Plan exists at all — a genuinely broken platform
      // configuration (an empty `plans` catalog), not a per-organization
      // edge case any caller could have avoided. Fails the whole
      // Organization-creation transaction loudly rather than silently
      // leaving a subscription-less Organization behind.
      this.logger.error('No active Plan exists — cannot bootstrap a subscription.');
      throw new InternalServerErrorException({
        messageKey: 'errors.entitlement.noPlanAvailable',
      });
    }

    await this.tenantSubscriptionsRepository.create(tx, {
      organizationId,
      planId: plan.id,
      // No trial. `trialEndsAt: null` + `status: 'expired'` is the
      // existing, already-handled representation of "no usable
      // entitlement yet" — see this class's own doc comment.
      trialEndsAt: null,
      status: 'expired',
    });
  }
}
