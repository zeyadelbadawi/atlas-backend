/**
 * ManualTransferProvider — the registry's only real, registered
 * `PaymentProviderAdapter` today (ADR-010, 2026-08-26 update). Backs
 * Atlas's own `payment_methods` catalog rows (`provider: 'atlas_manual'`,
 * both `manual_bank_transfer`/`manual_wallet_transfer` types) — the exact
 * P12 manual-transfer behavior, extracted out of `PaymentService` with
 * zero behavioral change, not reimplemented.
 *
 * `buildInitialNextAction` is byte-for-byte the ternary
 * `PaymentService.createPayment` used to inline
 * (`capabilities.supportsProof ? { type: 'awaiting_proof' } : null`) —
 * moving it here does not change what any existing P12 test observes.
 *
 * `availableForOrganizationGateway` is `false`: `'atlas_manual'` is Atlas's
 * own internal subscription-billing provider key, never a real external
 * gateway an Organization could "connect" for Organization-Owned Gateway
 * mode (§4.1) — surfacing it in that dashboard's provider list would be
 * incorrect, not merely incomplete.
 *
 * `availableForAtlasSubscription` is `true` (2026-08-26, Atlas Subscription
 * Payment readiness) — the reverse case: this genuinely IS Atlas's real,
 * currently-active subscription payment method, so it correctly appears in
 * the Platform Owner's provider-selection list. No `createPaymentIntent`
 * implementation exists here — manual transfer has no online
 * checkout/redirect concept — so `AtlasSubscriptionPaymentProviderService`/
 * `PaymentService.createPaymentIntent` correctly treat this adapter as "no
 * intent capability," exactly matching P12's existing, unchanged behavior.
 */
import { Injectable } from '@nestjs/common';
import type {
  PaymentProviderAdapter,
  PaymentProviderTestConnectionResult,
} from './payment-provider.interface';
import type { PaymentMethodCapabilitiesResponse } from '../dto/payment-method.contract';

export const MANUAL_TRANSFER_PROVIDER_KEY = 'atlas_manual';

@Injectable()
export class ManualTransferProvider implements PaymentProviderAdapter {
  readonly providerKey = MANUAL_TRANSFER_PROVIDER_KEY;
  readonly displayName = 'Manual Transfer';
  readonly availableForOrganizationGateway = false;
  readonly availableForAtlasSubscription = true;

  buildInitialNextAction(
    capabilities: PaymentMethodCapabilitiesResponse,
  ): Record<string, unknown> | null {
    return capabilities.supportsProof ? { type: 'awaiting_proof' } : null;
  }

  /**
   * Manual transfer has no external connection to verify — there is no
   * credential, endpoint, or account to reach. Returns a real, honest,
   * always-true result rather than being called at all in practice (no
   * Organization ever configures `'atlas_manual'` as its own gateway,
   * since it is not `availableForOrganizationGateway`); implemented anyway
   * so this class is a genuinely complete, real `PaymentProviderAdapter`.
   */
  async testConnection(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _config: Record<string, unknown>,
  ): Promise<PaymentProviderTestConnectionResult> {
    return { success: true, message: 'Manual transfer requires no external connection.' };
  }
}
