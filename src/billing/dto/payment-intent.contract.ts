/**
 * `PaymentIntent` response contract — matches the frontend's own
 * `PaymentIntent` (`payment.types.ts`) field-for-field. Real and callable
 * (P12's own doc comment: "not a fake implementation") — until a real
 * gateway adapter implements `PaymentProviderAdapter.createPaymentIntent`,
 * `PaymentService.createPaymentIntent` never actually reaches the success
 * path that constructs one of these (see that method's own doc comment).
 */
import type { Checkout as PrismaCheckout } from '@prisma/client';
import type { PaymentIntentResult } from '../providers/payment-provider.interface';

export interface PaymentIntentResponse {
  readonly checkoutId: string;
  readonly organizationId: string;
  readonly provider: string;
  readonly clientReference: string;
  readonly providerReference?: string;
  readonly checkoutUrl?: string;
  readonly expiresAt: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export function toPaymentIntentResponse(
  checkout: PrismaCheckout,
  providerKey: string,
  clientReference: string,
  result: PaymentIntentResult,
): PaymentIntentResponse {
  return {
    checkoutId: checkout.id,
    organizationId: checkout.organizationId,
    provider: providerKey,
    clientReference,
    providerReference: result.providerReference,
    checkoutUrl: result.checkoutUrl,
    expiresAt: result.expiresAt,
    metadata: result.metadata,
  };
}
