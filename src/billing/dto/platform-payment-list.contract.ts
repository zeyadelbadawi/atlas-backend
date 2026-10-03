/**
 * Platform Owner subscription-payment review contracts (`GET /payments`,
 * `GET /payments/:id`).
 *
 * The LIST item is `PaymentResponse` minus the data a queue row never
 * needs and should not carry in bulk:
 *
 *   - `instructions` — the Platform's receiving bank account / wallet /
 *     InstaPay numbers as shown to the payer;
 *   - the proof's free-text `note` (the proof's presence, file name and
 *     upload time stay, so the queue can tell "proof submitted").
 *
 * Both are still on the DETAIL response, which only an authorized
 * Platform Owner opening one payment receives.
 *
 * Both shapes add the review context the reviewer needs instead of raw
 * ids: the paying organization's name and what the checkout was for (plan
 * or add-on key, its display name as frozen on the checkout, and the
 * billing cycle).
 */
import type { CheckoutTargetType, SubscriptionBillingCycle } from '@prisma/client';
import type { PaymentWithSubscriptionReviewContext } from '../repositories/payments.repository';
import { toPaymentResponse, type PaymentResponse } from './payment.contract';

export interface PlatformPaymentCheckoutSummary {
  readonly targetType: CheckoutTargetType;
  /** The plan key (`plan_subscription`) or add-on key (`add_on`). */
  readonly targetKey: string;
  /** The plan/add-on display name frozen on the checkout snapshot. */
  readonly displayName?: string;
  readonly billingCycle?: SubscriptionBillingCycle;
}

export interface PlatformPaymentReviewContext {
  readonly organization?: { readonly id: string; readonly name: string };
  readonly checkoutSummary?: PlatformPaymentCheckoutSummary;
}

export type PlatformPaymentListItemResponse = Omit<PaymentResponse, 'instructions'> &
  PlatformPaymentReviewContext;

export type PlatformPaymentDetailResponse = PaymentResponse &
  PlatformPaymentReviewContext;

function toReviewContext(
  payment: PaymentWithSubscriptionReviewContext,
): PlatformPaymentReviewContext {
  const snapshot = (payment.checkout?.snapshot ?? null) as {
    displayName?: unknown;
  } | null;
  return {
    organization: payment.organization
      ? { id: payment.organization.id, name: payment.organization.name }
      : undefined,
    checkoutSummary: payment.checkout
      ? {
          targetType: payment.checkout.targetType,
          targetKey: payment.checkout.targetKey,
          displayName:
            typeof snapshot?.displayName === 'string' ? snapshot.displayName : undefined,
          billingCycle: payment.checkout.billingCycle ?? undefined,
        }
      : undefined,
  };
}

export function toPlatformPaymentListItemResponse(
  payment: PaymentWithSubscriptionReviewContext,
): PlatformPaymentListItemResponse {
  const { instructions: _instructions, proof, ...rest } = toPaymentResponse(payment);
  void _instructions;
  return {
    ...rest,
    proof: proof ? { ...proof, note: undefined } : undefined,
    ...toReviewContext(payment),
  };
}

export function toPlatformPaymentDetailResponse(
  payment: PaymentWithSubscriptionReviewContext,
): PlatformPaymentDetailResponse {
  return { ...toPaymentResponse(payment), ...toReviewContext(payment) };
}
