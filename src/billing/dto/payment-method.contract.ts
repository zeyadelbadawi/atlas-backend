/**
 * `PaymentMethod` response contract — matches `CheckoutPaymentMethod`
 * (`payment.types.ts`) field-for-field. `capabilities`/`manualInstructions`
 * are stored as JSONB and validated only at seed time (no write endpoint
 * exists — this is a platform-owned catalog, mirrors `plans`/`add_ons`'s
 * established "no write endpoint, seeded directly" P4 precedent).
 */
import type { PaymentMethod as PrismaPaymentMethod } from '@prisma/client';

export interface PaymentMethodCapabilitiesResponse {
  readonly supportsManualReview: boolean;
  readonly supportsProof: boolean;
  readonly supportsRedirect: boolean;
  readonly supportsEmbeddedCheckout: boolean;
  readonly supportsAdditionalAuthentication: boolean;
  readonly supportsWebhooks: boolean;
  readonly supportsRefunds: boolean;
  readonly supportsRecurring: boolean;
  readonly supportsCancellation: boolean;
}

export type ManualPaymentInstructionsResponse =
  | {
      readonly type: 'manual_bank_transfer';
      readonly bankName: string;
      readonly accountName: string;
      readonly accountNumber: string;
      readonly iban?: string;
      readonly instructions: string;
      readonly referenceInstructions: string;
    }
  | {
      readonly type: 'manual_wallet_transfer';
      readonly walletProvider: string;
      readonly walletNumber: string;
      readonly accountName: string;
      readonly instructions: string;
      readonly referenceInstructions: string;
    };

export interface PaymentMethodResponse {
  readonly id: string;
  readonly key: string;
  readonly type: PrismaPaymentMethod['type'];
  readonly displayName: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly provider: string;
  readonly capabilities: PaymentMethodCapabilitiesResponse;
  readonly manualInstructions?: ManualPaymentInstructionsResponse;
}

export function toPaymentMethodResponse(
  method: PrismaPaymentMethod,
): PaymentMethodResponse {
  return {
    id: method.id,
    key: method.key,
    type: method.type,
    displayName: method.displayName,
    description: method.description ?? undefined,
    enabled: method.enabled,
    provider: method.provider,
    capabilities: method.capabilities as unknown as PaymentMethodCapabilitiesResponse,
    manualInstructions:
      (method.manualInstructions as unknown as ManualPaymentInstructionsResponse | null) ??
      undefined,
  };
}
