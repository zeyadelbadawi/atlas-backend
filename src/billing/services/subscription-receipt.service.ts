/**
 * SubscriptionReceiptService — the ONE emitter of the subscription receipt
 * (`lifecycle.subscription.activated`, §27 S1).
 *
 * WHY IT LIVES BEHIND `PaymentApplicationService`. A plan becomes active
 * in exactly one place — `PaymentApplicationService.applySuccessfulPayment`
 * — whichever way the money was confirmed: a Platform Owner approving a
 * manual transfer (bank transfer, wallet transfer, InstaPay — every
 * `manual_*` method) or a signed `payment.succeeded` webhook. The receipt
 * used to be emitted by the approval path alone, so a webhook-confirmed
 * activation produced a subscription and no email at all. Emitting it from
 * the shared apply step means every way a payment can succeed now ends in
 * the same receipt, and a future payment method gets it without anyone
 * having to remember to add it.
 *
 * EXACTLY ONCE PER ACTIVATION. It is called only when the payment actually
 * transitioned into `succeeded` (`markSucceededIfNotAlready` returned
 * true), so the second of an approval and a webhook for the same payment —
 * which applies no commercial effect — sends nothing either. Beneath that,
 * the catalog's dedupe key (`subscription_activated:<organization>:<new
 * currentPeriodEnd>`) and the outbox's `(recipient_user_id, dedupe_key)`
 * unique constraint reject any replay that still reaches it.
 *
 * Returns a no-op result (and writes nothing) unless this payment was for
 * a PLAN and the subscription now has a real period: an add-on purchase,
 * or a subscription row the purchase somehow left undated, must not
 * produce a receipt claiming dates it does not have.
 *
 * The limits are read from `granted_limits` through
 * `resolveSubscriptionLimits` — the one function that answers "what is
 * this customer entitled to" — so the receipt can never quote a number the
 * write gate would not honour.
 *
 * W8 — gifted days. The row read here is the one the apply step just wrote
 * in THIS transaction, so its gift columns and period are the values
 * committed with this payment, never a recomputation from the plan. The
 * outbox row commits atomically with them and is only enqueued after
 * commit. The gift values are added only when this payment is the one that
 * was granted the gift (`giftedPaymentId`): the columns stay set on the row
 * for every later renewal, whose receipt must not mention them.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { CommunicationService } from '../../communications/services/communication.service';
import type { EmitResult } from '../../communications/services/communication.service';
import { formatLifecycleInstant } from '../../plans/services/tenant-lifecycle.service';
import { resolveSubscriptionLimits } from '../../plans/utils/granted-limits.util';

const NONE: EmitResult = { created: false, outboxId: null };

@Injectable()
export class SubscriptionReceiptService {
  constructor(private readonly communicationService: CommunicationService) {}

  async emitActivated(
    tx: Prisma.TransactionClient,
    args: {
      readonly organizationId: string;
      readonly checkoutId: string | null;
      readonly paymentId: string;
    },
  ): Promise<EmitResult> {
    const { organizationId, checkoutId, paymentId } = args;
    if (!checkoutId) return NONE;

    const checkout = await tx.checkout.findUnique({
      where: { id: checkoutId },
      select: { targetType: true },
    });
    if (checkout?.targetType !== 'plan_subscription') return NONE;

    // The receipt goes to the organization's owner — the person who
    // controls billing — whoever confirmed the payment.
    const organization = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { ownerUserId: true },
    });
    if (!organization) return NONE;

    const subscription = await tx.tenantSubscription.findUnique({
      where: { organizationId },
      select: {
        currentPeriodStart: true,
        currentPeriodEnd: true,
        grantedLimits: true,
        giftedDays: true,
        giftedStartsAt: true,
        giftedEndsAt: true,
        giftedPaymentId: true,
        plan: { select: { name: true, limits: true } },
      },
    });
    if (!subscription?.currentPeriodEnd || !subscription.currentPeriodStart) return NONE;

    const { giftedDays, giftedStartsAt, giftedEndsAt } = subscription;
    const gift =
      subscription.giftedPaymentId === paymentId &&
      giftedDays !== null &&
      giftedDays > 0 &&
      giftedStartsAt !== null &&
      giftedEndsAt !== null
        ? {
            giftedDays,
            giftStartDate: formatLifecycleInstant(giftedStartsAt),
            giftEndDate: formatLifecycleInstant(giftedEndsAt),
          }
        : {};

    const limits = resolveSubscriptionLimits(subscription);
    return this.communicationService.emit(tx, {
      key: 'lifecycle.subscription.activated',
      recipientUserId: organization.ownerUserId,
      organizationId,
      entity: { type: 'tenant_subscription', id: organizationId },
      values: {
        anchorAt: subscription.currentPeriodEnd.toISOString(),
        planName: subscription.plan.name,
        periodStartDate: formatLifecycleInstant(subscription.currentPeriodStart),
        periodEndDate: formatLifecycleInstant(subscription.currentPeriodEnd),
        academiesLimit: String(limits.academies ?? ''),
        studentsLimit: String(limits.students ?? ''),
        coursesLimit: String(limits.courses ?? ''),
        ...gift,
      },
    });
  }
}
