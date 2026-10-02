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

/**
 * The account holder and customer-facing texts every manual method has.
 * `…Ar` are the Arabic versions (optional; the English is the fallback).
 * `placeholder: true` marks details that are not a real payment
 * destination yet (never set through the API; see the 20261102000400
 * migration): such a method cannot be enabled or paid in production.
 */
interface ManualInstructionTexts {
  readonly accountName: string;
  readonly accountNameAr?: string;
  readonly instructions: string;
  readonly instructionsAr?: string;
  readonly referenceInstructions: string;
  readonly referenceInstructionsAr?: string;
  readonly placeholder?: boolean;
}

export type ManualPaymentInstructionsResponse =
  | (ManualInstructionTexts & {
      readonly type: 'manual_bank_transfer';
      readonly bankName: string;
      readonly accountNumber: string;
      readonly iban?: string;
      readonly swiftCode?: string;
    })
  | (ManualInstructionTexts & {
      readonly type: 'manual_wallet_transfer';
      /** `vodafone_cash` | `orange_cash` | `etisalat_cash` | `we_pay` | `other` (older rows: free text). */
      readonly walletProvider: string;
      /** The provider's name, for `other`. */
      readonly walletProviderName?: string;
      readonly walletNumber: string;
    })
  | (ManualInstructionTexts & {
      readonly type: 'manual_instapay';
      readonly instapayAddress: string;
    });

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

/** The Platform Owner's view: every method, enabled or not, with its ordering and timestamps. */
export interface PlatformPaymentMethodResponse extends PaymentMethodResponse {
  readonly displayOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toPlatformPaymentMethodResponse(
  method: PrismaPaymentMethod,
): PlatformPaymentMethodResponse {
  return {
    ...toPaymentMethodResponse(method),
    displayOrder: method.displayOrder,
    createdAt: method.createdAt.toISOString(),
    updatedAt: method.updatedAt.toISOString(),
  };
}
