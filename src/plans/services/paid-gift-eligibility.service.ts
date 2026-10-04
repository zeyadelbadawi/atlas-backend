/**
 * PaidGiftEligibilityService — THE single authority on "does this approved
 * plan payment receive gifted setup days?" (W8A).
 *
 * THE RULES, all evaluated server-side inside the approval transaction,
 * cheapest and non-consuming first, the atomic ledger claim LAST:
 *
 *   1. The purchase starts a FRESH subscription (it does not extend a
 *      running paid period). Early renewals and plan changes while active
 *      never receive a gift.
 *   2. The plan, as re-read from the live catalog, has a gift configured for
 *      the resolved billing cycle (`plans.gifted_days_monthly|yearly`,
 *      5..15; NULL or 0 = none).
 *   3. This organization has never had a gift (`gifted_days IS NULL`) and
 *      has never had a paid period (`current_period_end IS NULL` — a trial
 *      never sets it), and has no other succeeded plan payment. So a lapsed
 *      customer re-subscribing, including one who paid before this feature
 *      existed, gets no gift.
 *   4. The organization OWNER is a live account (not deleted).
 *   5. The owner's customer identity — HMAC v2 of the canonical email, the
 *      same identity as the trial ledger — has never redeemed a gift. This is
 *      decided by INSERT ... ON CONFLICT DO NOTHING into the append-only
 *      `paid_gift_redemptions` (UNIQUE subject_hash): the insert's row count
 *      IS the decision, so two simultaneous first payments for one identity
 *      (two organizations, two checkouts) yield exactly one gift, and a
 *      deleted-then-re-registered owner, a second organization, or a Gmail
 *      alias of the same mailbox is refused.
 *
 * A free trial is a DIFFERENT benefit: a trialist who converts still gets
 * the gift. A refund never restores eligibility (the ledger has no UPDATE/
 * DELETE for the application role).
 *
 * No email, canonical address or digest is ever logged.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, SubscriptionBillingCycle } from '@prisma/client';
import { addDaysUtc, giftedDaysForCycle } from '../../billing/utils/billing-period.util';
import {
  CURRENT_SUBJECT_HASH_VERSION,
  CustomerIdentityHasher,
} from './customer-identity-hasher.service';

export type GiftSource = 'approval' | 'gateway';

export type GiftRefusalReason =
  | 'not_fresh_start'
  | 'no_gift_configured'
  | 'organization_already_paid'
  | 'owner_unavailable'
  | 'already_redeemed';

export interface GiftDecisionInput {
  readonly organizationId: string;
  readonly paymentId: string;
  readonly plan: {
    readonly key: string;
    readonly giftedDaysMonthly: number | null;
    readonly giftedDaysYearly: number | null;
  };
  readonly billingCycle: SubscriptionBillingCycle;
  readonly extendsCurrentPeriod: boolean;
  /** The subscription row as read under the per-organization lock, or null when none exists yet. */
  readonly existing: {
    readonly currentPeriodEnd: Date | null;
    readonly giftedDays: number | null;
  } | null;
  readonly now: Date;
  readonly source: GiftSource;
}

export type GiftDecision =
  | {
      readonly granted: true;
      readonly days: number;
      readonly startsAt: Date;
      readonly endsAt: Date;
    }
  | { readonly granted: false; readonly reason: GiftRefusalReason };

export interface GiftAvailabilityInput {
  readonly organizationId: string;
  readonly existing: {
    readonly currentPeriodEnd: Date | null;
    readonly giftedDays: number | null;
  } | null;
}

@Injectable()
export class PaidGiftEligibilityService {
  private readonly logger = new Logger(PaidGiftEligibilityService.name);

  constructor(private readonly hasher: CustomerIdentityHasher) {}

  /**
   * Decides AND records, atomically, in the caller's transaction. A caller
   * that sees `granted: false` must not grant a gift. Never throws for an
   * ordinary refusal.
   */
  async claimFirstPaidGift(
    tx: Prisma.TransactionClient,
    input: GiftDecisionInput,
  ): Promise<GiftDecision> {
    if (input.extendsCurrentPeriod) return { granted: false, reason: 'not_fresh_start' };

    const days = giftedDaysForCycle(input.plan, input.billingCycle);
    if (days === null) return { granted: false, reason: 'no_gift_configured' };

    if (
      await this.organizationHasPaidBefore(
        tx,
        input.organizationId,
        input.existing,
        input.paymentId,
      )
    ) {
      return { granted: false, reason: 'organization_already_paid' };
    }

    const owner = await this.loadLiveOwner(tx, input.organizationId);
    if (!owner) return { granted: false, reason: 'owner_unavailable' };

    const { v2: subjectHash } = this.hasher.subjectHashes(owner.email);
    const startsAt = input.now;
    const endsAt = addDaysUtc(startsAt, days);

    // ON CONFLICT DO NOTHING, never create()+catch: a raised unique
    // violation would abort the whole approval transaction (see
    // `TrialEligibilityService.claimTrial` for the incident behind this).
    const inserted = await tx.paidGiftRedemption.createMany({
      data: [
        {
          subjectHash,
          hashVersion: CURRENT_SUBJECT_HASH_VERSION,
          organizationId: input.organizationId,
          redeemedByUserId: owner.id,
          paymentId: input.paymentId,
          planKey: input.plan.key,
          billingCycle: input.billingCycle,
          giftedDays: days,
          giftedStartsAt: startsAt,
          giftedEndsAt: endsAt,
          source: input.source,
        },
      ],
      skipDuplicates: true,
    });

    if (inserted.count !== 1) {
      this.logger.log(
        { organizationId: input.organizationId, paymentId: input.paymentId },
        'Gifted setup days refused — this customer identity has already received them.',
      );
      return { granted: false, reason: 'already_redeemed' };
    }
    return { granted: true, days, startsAt, endsAt };
  }

  /**
   * Read-only, for DISPLAY only ("Includes N gifted setup days" on the
   * plans/checkout surfaces). Never use it to gate a grant —
   * `claimFirstPaidGift` re-decides atomically at approval.
   */
  async describeGiftAvailability(
    tx: Prisma.TransactionClient,
    input: GiftAvailabilityInput,
  ): Promise<boolean> {
    if (
      await this.organizationHasPaidBefore(tx, input.organizationId, input.existing, null)
    ) {
      return false;
    }
    const owner = await this.loadLiveOwner(tx, input.organizationId);
    if (!owner) return false;
    const { v2 } = this.hasher.subjectHashes(owner.email);
    const existing = await tx.paidGiftRedemption.findUnique({
      where: { subjectHash: v2 },
      select: { id: true },
    });
    return existing === null;
  }

  private async organizationHasPaidBefore(
    tx: Prisma.TransactionClient,
    organizationId: string,
    existing: GiftAvailabilityInput['existing'],
    excludePaymentId: string | null,
  ): Promise<boolean> {
    if (
      existing &&
      (existing.giftedDays !== null || existing.currentPeriodEnd !== null)
    ) {
      return true;
    }
    const priorPaid = await tx.payment.count({
      where: {
        organizationId,
        status: 'succeeded',
        ...(excludePaymentId ? { id: { not: excludePaymentId } } : {}),
        checkout: { targetType: 'plan_subscription' },
      },
    });
    return priorPaid > 0;
  }

  private async loadLiveOwner(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<{ id: string; email: string } | null> {
    const organization = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { owner: { select: { id: true, email: true, status: true } } },
    });
    const owner = organization?.owner;
    if (!owner || owner.status === 'deleted' || !owner.email) return null;
    return { id: owner.id, email: owner.email };
  }
}
