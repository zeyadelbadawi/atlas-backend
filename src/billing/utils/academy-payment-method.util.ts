/**
 * Academy Manual Payments — how one academy's own method
 * (`academy_payment_methods` row) is named and shown.
 *
 * A learner's checkout lists methods as `PaymentMethodResponse`, the same
 * shape the platform catalog uses, so the existing checkout UI and the
 * `POST course-orders/:id/payments {methodKey}` contract serve both. An
 * academy method's key is derived from its type (`academy_<type>`): an
 * academy has at most one method per type, so the key is unique within the
 * academy, stable across edits, and never collides with a platform key
 * (`bank_transfer_<hex>`, `wallet_<hex>`, `instapay_<hex>`).
 */
import type { AcademyPaymentMethod, PaymentMethodType } from '@prisma/client';
import { ACADEMY_MANUAL_PROVIDER_KEY } from '../dto/billing.constants';
import type {
  ManualPaymentInstructionsResponse,
  PaymentMethodResponse,
} from '../dto/payment-method.contract';
import {
  MANUAL_TRANSFER_CAPABILITIES,
  type ManualMethodType,
} from './manual-payment-instructions.util';

export const ACADEMY_PAYMENT_METHOD_TYPES: readonly ManualMethodType[] = [
  'manual_bank_transfer',
  'manual_instapay',
  'manual_wallet_transfer',
];

const KEY_PREFIX = 'academy_';

/** Default English names; the frontend shows its own localized label per type. */
const DISPLAY_NAMES: Record<ManualMethodType, string> = {
  manual_bank_transfer: 'Bank transfer',
  manual_instapay: 'InstaPay',
  manual_wallet_transfer: 'Mobile wallet',
};

export function academyPaymentMethodKey(type: PaymentMethodType): string {
  return `${KEY_PREFIX}${type}`;
}

export function isAcademyManualMethodType(value: string): value is ManualMethodType {
  return (ACADEMY_PAYMENT_METHOD_TYPES as readonly string[]).includes(value);
}

/** The checkout's view of an academy method — the learner sees what they must pay to. */
export function toAcademyCheckoutMethodResponse(
  method: AcademyPaymentMethod,
): PaymentMethodResponse {
  const type = method.type as ManualMethodType;
  return {
    id: method.id,
    key: academyPaymentMethodKey(method.type),
    type: method.type,
    displayName: DISPLAY_NAMES[type] ?? method.type,
    enabled: method.enabled,
    provider: ACADEMY_MANUAL_PROVIDER_KEY,
    capabilities: { ...MANUAL_TRANSFER_CAPABILITIES },
    manualInstructions:
      method.instructions as unknown as ManualPaymentInstructionsResponse,
  };
}
