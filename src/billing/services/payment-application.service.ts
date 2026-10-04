/**
 * PaymentApplicationService — the ONE place a Payment's success or failure
 * is actually applied to `payments`/`checkouts`/`tenant_subscriptions`/
 * `tenant_add_ons`. Both `PlatformPaymentService.approvePayment` (a human
 * reviewer) and `PaymentWebhookService` (a future gateway's
 * `payment.succeeded` event) call this SAME method — never two parallel
 * "apply success" implementations — matching master plan §10's own
 * transaction rule: "any mutation touching more than one table that must
 * be atomic... runs inside one database transaction."
 *
 * Every method here takes an already-open `Prisma.TransactionClient` — it
 * never opens its own `runInTenantContext`/`runInUserContext`, because the
 * whole point is to run as one step of a LARGER atomic transaction the
 * caller already established (payment update + checkout update +
 * subscription/add-on update all succeed or all roll back together).
 *
 * "Payment is not Subscription" (frontend `Reports/ARCHITECTURE.md`,
 * Prompt 7): this is the one and only server-side trigger that turns a
 * successful Payment into a real `tenant_subscriptions`/`tenant_add_ons`
 * change — the frontend never performs this mutation itself, only reacts
 * to `Payment.status === 'succeeded'` afterward.
 */
import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { limitsToGrant } from '../../plans/utils/granted-limits.util';
import { Prisma } from '@prisma/client';
import type { Checkout, Payment } from '@prisma/client';
import { CheckoutsRepository } from '../repositories/checkouts.repository';
import { PaymentsRepository } from '../repositories/payments.repository';
import { PlansRepository } from '../../plans/repositories/plans.repository';
import { AddOnsRepository } from '../../plans/repositories/add-ons.repository';
import { TenantSubscriptionsRepository } from '../../plans/repositories/tenant-subscriptions.repository';
import { TenantAddOnsRepository } from '../../plans/repositories/tenant-add-ons.repository';
import { PLANS_CLOCK, type Clock } from '../../plans/utils/clock';
import {
  PaidGiftEligibilityService,
  type GiftSource,
} from '../../plans/services/paid-gift-eligibility.service';
import {
  computePurchaseDates,
  resolvePurchaseBillingCycle,
} from '../utils/billing-period.util';
import type { EmitResult } from '../../communications/services/communication.service';
import { SubscriptionReceiptService } from './subscription-receipt.service';

export interface ApplySuccessOptions {
  /** Who confirmed the money: a human reviewer (default) or a gateway webhook. Recorded on a gift. */
  readonly source?: GiftSource;
}

export interface AppliedPayment {
  readonly payment: Payment;
  /**
   * The subscription receipt this application emitted, if any. The caller
   * passes `receipt.outboxId` to `CommunicationService.enqueueAfterCommit`
   * once its transaction has committed (the one-minute sweep is the
   * fallback).
   */
  readonly receipt: EmitResult;
}

const NO_RECEIPT: EmitResult = { created: false, outboxId: null };

@Injectable()
export class PaymentApplicationService {
  constructor(
    private readonly checkoutsRepository: CheckoutsRepository,
    private readonly paymentsRepository: PaymentsRepository,
    private readonly plansRepository: PlansRepository,
    private readonly addOnsRepository: AddOnsRepository,
    private readonly tenantSubscriptionsRepository: TenantSubscriptionsRepository,
    private readonly tenantAddOnsRepository: TenantAddOnsRepository,
    private readonly paidGiftEligibilityService: PaidGiftEligibilityService,
    private readonly subscriptionReceiptService: SubscriptionReceiptService,
    @Inject(PLANS_CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Applies a successful Payment: marks it `succeeded`, completes its
   * Checkout, and — the real commercial effect — updates
   * `tenant_subscriptions`/`tenant_add_ons` from the Checkout's frozen
   * `snapshot.target`, never the live catalog. Throws (rolling back the
   * whole caller transaction) if there is no `tenant_subscriptions` row to
   * update yet — real subscription CREATION is Phase P14 provisioning, not
   * this phase's job (see `TenantSubscriptionsRepository.
   * updateForPlanPurchase`'s own doc comment).
   *
   * W8 D2 — IDEMPOTENT PER PAYMENT. The transition into `succeeded` is one
   * conditional UPDATE (`markSucceededIfNotAlready`). A payment that is
   * already succeeded — a webhook arriving after a manual approval, a
   * replay with a new event id, or a concurrent applier that lost the row
   * lock — returns the current row and applies NO commercial effect, so a
   * second paid period can never be stacked onto one payment.
   *
   * RECEIPT. When the payment transitions and buys a plan, the
   * subscription receipt is emitted here, in the same transaction, for
   * every way a payment can succeed (manual approval or gateway webhook) —
   * see `SubscriptionReceiptService`. A payment that does not transition
   * emits nothing, so an approval and a webhook for the same payment
   * produce one receipt between them.
   */
  async applySuccessfulPayment(
    tx: Prisma.TransactionClient,
    payment: Payment,
    options: ApplySuccessOptions = {},
  ): Promise<AppliedPayment> {
    const transitioned = await this.paymentsRepository.markSucceededIfNotAlready(
      tx,
      payment.id,
    );
    const updated = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
    if (!transitioned) return { payment: updated, receipt: NO_RECEIPT };

    if (!payment.checkoutId) return { payment: updated, receipt: NO_RECEIPT };

    const checkout = await tx.checkout.findUnique({ where: { id: payment.checkoutId } });
    if (!checkout) return { payment: updated, receipt: NO_RECEIPT };

    await this.checkoutsRepository.updateStatus(tx, checkout.id, 'completed');
    await this.applyCommercialEffect(
      tx,
      checkout,
      payment.id,
      options.source ?? 'approval',
    );

    const receipt = await this.subscriptionReceiptService.emitActivated(tx, {
      organizationId: checkout.organizationId,
      checkoutId: checkout.id,
      paymentId: payment.id,
    });
    return { payment: updated, receipt };
  }

  async applyFailedPayment(
    tx: Prisma.TransactionClient,
    payment: Payment,
    failureReasonKey: string,
  ): Promise<Payment> {
    return this.paymentsRepository.update(tx, payment.id, {
      status: 'failed',
      failureReason: failureReasonKey,
      nextAction: Prisma.JsonNull,
    });
  }

  /**
   * Always re-resolves the catalog row by `checkout.targetKey` — the
   * commercial effect (which Plan/AddOn gets activated) is never taken
   * from `checkout.snapshot`, which is display/audit data frozen at
   * Checkout-creation time (master plan §5.7) and could be stale by the
   * time a manual review completes.
   */
  private async applyCommercialEffect(
    tx: Prisma.TransactionClient,
    checkout: Checkout,
    paymentId: string,
    source: GiftSource,
  ): Promise<void> {
    if (checkout.targetType === 'plan_subscription') {
      const plan = await this.plansRepository.findByKey(checkout.targetKey);
      if (!plan) {
        throw new NotFoundException({ messageKey: 'errors.checkout.planNoLongerExists' });
      }

      const now = this.clock.now();
      /*
        RENEWAL BEFORE EXPIRY EXTENDS; RENEWAL AFTER EXPIRY RESTARTS.
        A customer who pays while their paid period is still running
        (`active`, or `grace_period` whose period end is somehow still
        ahead) has bought the NEXT period, so it starts where the current
        one ends — paying early must never forfeit days already paid for.
        Any other state (a lapsed period, a grace window, a trial, a
        cancelled or expired row) starts fresh from now: there is no
        remaining paid time to add to. `upsertForPlanPurchase` resets
        `graceEndsAt` and `cancelAtPeriodEnd` on every purchase, so a
        cancel-then-renew customer is simply active again.
      */
      // W8 — serialise purchases per organization. Two different payments
      // for one organization approved at the same moment would otherwise
      // both read the pre-purchase row and the later commit would overwrite
      // the earlier one's period (and a gift's dates). Under READ COMMITTED
      // the read below runs after the lock is granted, so it sees the
      // winner's committed row and extends from it.
      await this.tenantSubscriptionsRepository.lockForPurchase(
        tx,
        checkout.organizationId,
      );
      const existing = await this.tenantSubscriptionsRepository.findByOrganizationId(
        tx,
        checkout.organizationId,
      );
      const extendsCurrentPeriod =
        existing !== null &&
        (existing.status === 'active' || existing.status === 'grace_period') &&
        existing.currentPeriodEnd !== null &&
        existing.currentPeriodEnd.getTime() > now.getTime();
      const periodStart = extendsCurrentPeriod ? existing.currentPeriodEnd! : now;
      // W8 D4 — the column first, then the frozen snapshot's native cycle.
      const billingCycle = resolvePurchaseBillingCycle(
        checkout.billingCycle,
        checkout.snapshot,
      );

      // W8A — gifted setup days on a customer's first-ever paid
      // subscription. Decided (and recorded in the append-only ledger) only
      // here, server-side, in this transaction.
      const gift = await this.paidGiftEligibilityService.claimFirstPaidGift(tx, {
        organizationId: checkout.organizationId,
        paymentId,
        plan,
        billingCycle,
        extendsCurrentPeriod,
        existing: existing
          ? {
              currentPeriodEnd: existing.currentPeriodEnd,
              giftedDays: existing.giftedDays,
            }
          : null,
        now,
        source,
      });
      const dates = computePurchaseDates({
        periodStart,
        billingCycle,
        giftedDays: gift.granted ? gift.days : null,
      });
      // Phase P19 (`Reports/DEVELOPMENT_E2E_FLOW_AUDIT.md` P0-3):
      // `upsertForPlanPurchase` now creates the Organization's first-ever
      // `tenant_subscriptions` row itself when none exists yet, rather
      // than this call site catching `P2025` and refusing — see that
      // method's own doc comment for the full reasoning. This IS still
      // "the one and only server-side trigger that turns a successful
      // Payment into a real subscription change" (this file's own header
      // comment) for both the create and update cases now.
      await this.tenantSubscriptionsRepository.upsertForPlanPurchase(
        tx,
        checkout.organizationId,
        {
          planId: plan.id,
          // P61 — freeze what this purchase grants, from the plan row this
          // method just resolved. The money is already frozen on the
          // Payment; this is its entitlement counterpart, so a later
          // catalog edit cannot rewrite what the customer bought.
          //
          // An UPGRADE and a DOWNGRADE both land here, and both are
          // intentional customer decisions: each one re-grants from the
          // newly chosen plan. There is no grandfathering across a
          // deliberate plan change — only across catalog edits the
          // customer did not ask for.
          grantedLimits: limitsToGrant(plan) as unknown as Prisma.InputJsonValue,
          billingCycle,
          currentPeriodStart: dates.currentPeriodStart,
          currentPeriodEnd: dates.currentPeriodEnd,
          ...(dates.gift
            ? {
                gift: {
                  days: dates.gift.days,
                  startsAt: dates.gift.startsAt,
                  endsAt: dates.gift.endsAt,
                  paymentId,
                },
              }
            : {}),
        },
      );
      return;
    }

    // add_on
    const addOn = await this.addOnsRepository.findByKey(checkout.targetKey);

    // Defense in depth: even a checkout frozen while the add-on was still
    // published must not activate it if it has since been unpublished
    // (draft/coming_soon). Checkout creation already refuses non-published
    // add-ons, so reaching here means a stale/frozen order.
    if (addOn && addOn.catalogStatus !== 'published') {
      throw new ForbiddenException({ messageKey: 'errors.addOns.comingSoon' });
    }
    if (!addOn) {
      throw new NotFoundException({ messageKey: 'errors.checkout.addOnNoLongerExists' });
    }
    await this.tenantAddOnsRepository.activate(tx, checkout.organizationId, addOn.id);
  }
}
