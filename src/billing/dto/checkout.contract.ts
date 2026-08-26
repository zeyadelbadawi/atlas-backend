/** `Checkout` response contract — matches `Checkout` (`checkout.types.ts`) field-for-field. */
import type { Checkout as PrismaCheckout } from '@prisma/client';

export type CheckoutTargetResponse =
  | { readonly type: 'plan_subscription'; readonly planKey: string }
  | { readonly type: 'add_on'; readonly addOnKey: string };

export interface MoneyResponse {
  readonly amountMinorUnits: number;
  readonly currency: string;
}

export interface CheckoutSnapshotResponse {
  readonly target: CheckoutTargetResponse;
  readonly billingCycle?: PrismaCheckout['billingCycle'];
  readonly displayName: string;
  readonly price: MoneyResponse;
  readonly capturedAt: string;
}

export interface CheckoutResponse {
  readonly id: string;
  readonly organizationId: string;
  readonly target: CheckoutTargetResponse;
  readonly billingCycle?: PrismaCheckout['billingCycle'];
  readonly snapshot: CheckoutSnapshotResponse;
  readonly status: PrismaCheckout['status'];
  readonly expiresAt: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export function toCheckoutResponse(checkout: PrismaCheckout): CheckoutResponse {
  const target: CheckoutTargetResponse =
    checkout.targetType === 'plan_subscription'
      ? { type: 'plan_subscription', planKey: checkout.targetKey }
      : { type: 'add_on', addOnKey: checkout.targetKey };

  return {
    id: checkout.id,
    organizationId: checkout.organizationId,
    target,
    billingCycle: checkout.billingCycle ?? undefined,
    snapshot: checkout.snapshot as unknown as CheckoutSnapshotResponse,
    status: checkout.status,
    expiresAt: checkout.expiresAt.toISOString(),
    idempotencyKey: checkout.idempotencyKey,
    createdAt: checkout.createdAt.toISOString(),
  };
}
