import { NotFoundException } from '@nestjs/common';
import { PaymentProviderRegistry } from './payment-provider.registry';
import {
  ManualTransferProvider,
  MANUAL_TRANSFER_PROVIDER_KEY,
} from './manual-transfer.provider';

describe('PaymentProviderRegistry', () => {
  it('resolves ManualTransferProvider by its provider key', () => {
    const registry = new PaymentProviderRegistry(new ManualTransferProvider());
    const resolved = registry.resolveOrThrow(MANUAL_TRANSFER_PROVIDER_KEY);
    expect(resolved.providerKey).toBe(MANUAL_TRANSFER_PROVIDER_KEY);
  });

  it('tryResolve returns the same adapter for the registered key', () => {
    const registry = new PaymentProviderRegistry(new ManualTransferProvider());
    expect(registry.tryResolve(MANUAL_TRANSFER_PROVIDER_KEY)?.providerKey).toBe(
      MANUAL_TRANSFER_PROVIDER_KEY,
    );
  });

  it('tryResolve fails safely (returns null, never throws) for an unknown provider key', () => {
    const registry = new PaymentProviderRegistry(new ManualTransferProvider());
    expect(registry.tryResolve('some_future_gateway_not_yet_built')).toBeNull();
    expect(registry.tryResolve('')).toBeNull();
  });

  it('resolveOrThrow fails safely with a real, typed exception for an unknown provider key — never a raw crash', () => {
    const registry = new PaymentProviderRegistry(new ManualTransferProvider());
    expect(() => registry.resolveOrThrow('paymob')).toThrow(NotFoundException);
    expect(() => registry.resolveOrThrow('stripe')).toThrow(NotFoundException);
  });

  it('lists no providers available for Organization-Owned Gateway selection today — an honestly empty list, no fake gateway', () => {
    const registry = new PaymentProviderRegistry(new ManualTransferProvider());
    expect(registry.listAvailableForOrganizationGateway()).toEqual([]);
  });

  it('lists ManualTransferProvider as available for Atlas Subscription Payment selection — the real, currently active method', () => {
    const registry = new PaymentProviderRegistry(new ManualTransferProvider());
    expect(registry.listAvailableForAtlasSubscription()).toEqual([
      { providerKey: MANUAL_TRANSFER_PROVIDER_KEY, displayName: 'Manual Transfer' },
    ]);
  });
});
