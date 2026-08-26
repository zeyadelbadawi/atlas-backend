import {
  ManualTransferProvider,
  MANUAL_TRANSFER_PROVIDER_KEY,
} from './manual-transfer.provider';
import type { PaymentMethodCapabilitiesResponse } from '../dto/payment-method.contract';
import type { PaymentProviderAdapter } from './payment-provider.interface';

function capabilities(
  overrides: Partial<PaymentMethodCapabilitiesResponse> = {},
): PaymentMethodCapabilitiesResponse {
  return {
    supportsManualReview: true,
    supportsProof: true,
    supportsRedirect: false,
    supportsEmbeddedCheckout: false,
    supportsAdditionalAuthentication: false,
    supportsWebhooks: false,
    supportsRefunds: false,
    supportsRecurring: false,
    supportsCancellation: true,
    ...overrides,
  };
}

describe('ManualTransferProvider', () => {
  it('exposes the stable provider key existing payment_methods rows already use', () => {
    expect(new ManualTransferProvider().providerKey).toBe('atlas_manual');
    expect(MANUAL_TRANSFER_PROVIDER_KEY).toBe('atlas_manual');
  });

  it('is not available for Organization-Owned Gateway selection', () => {
    expect(new ManualTransferProvider().availableForOrganizationGateway).toBe(false);
  });

  it('IS available for Atlas Subscription Payment selection — it is the real, currently active method', () => {
    expect(new ManualTransferProvider().availableForAtlasSubscription).toBe(true);
  });

  it('implements no createPaymentIntent capability — manual transfer has no online checkout/redirect concept', () => {
    const provider: PaymentProviderAdapter = new ManualTransferProvider();
    expect(provider.createPaymentIntent).toBeUndefined();
  });

  it('builds the exact P12 next-action shape when the method supports proof — the same ternary PaymentService used to inline', () => {
    const provider = new ManualTransferProvider();
    expect(
      provider.buildInitialNextAction(capabilities({ supportsProof: true })),
    ).toEqual({
      type: 'awaiting_proof',
    });
  });

  it('builds no next action when the method does not support proof', () => {
    const provider = new ManualTransferProvider();
    expect(
      provider.buildInitialNextAction(capabilities({ supportsProof: false })),
    ).toBeNull();
  });

  it('testConnection always succeeds — there is no external connection for manual transfer', async () => {
    const provider = new ManualTransferProvider();
    await expect(provider.testConnection({})).resolves.toMatchObject({ success: true });
  });
});
