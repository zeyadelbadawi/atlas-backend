/**
 * Placeholder payment details are never offered or paid in production
 * (2 Oct 2026). The wallet and InstaPay rows the 20261102000400 migration
 * adds carry `placeholder: true` and destinations that are not real; e2e
 * runs as `test`, so the production rules are pinned here.
 */
import { ConflictException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { PlatformPaymentMethodsService } from './platform-payment-methods.service';
import { PaymentService } from './payment.service';

const PLACEHOLDER = {
  id: 'm1',
  key: 'wallet_vodafone_cash',
  type: 'manual_wallet_transfer',
  provider: 'atlas_manual',
  enabled: false,
  displayName: 'Vodafone Cash',
  description: null,
  displayOrder: 20,
  capabilities: { supportsProof: true },
  createdAt: new Date(),
  updatedAt: new Date(),
  manualInstructions: {
    type: 'manual_wallet_transfer',
    walletProvider: 'vodafone_cash',
    walletNumber: 'PLACEHOLDER-NOT-A-WALLET',
    accountName: 'Ziad Gehad',
    instructions: 'Placeholder',
    referenceInstructions: 'Placeholder',
    placeholder: true,
  },
};

const config = (isProduction: boolean) =>
  ({ getOrThrow: () => ({ isProduction }) }) as unknown as ConfigService;

function platformService(isProduction: boolean) {
  const repository = {
    findById: jest.fn().mockResolvedValue(PLACEHOLDER),
    update: jest.fn().mockImplementation((_tx, _id, data) => ({
      ...PLACEHOLDER,
      ...data,
      enabled: data.enabled ?? PLACEHOLDER.enabled,
      manualInstructions: data.manualInstructions ?? PLACEHOLDER.manualInstructions,
    })),
  };
  const prisma = { $transaction: jest.fn((fn) => fn({})) };
  const audit = { write: jest.fn() };
  const service = new PlatformPaymentMethodsService(
    prisma as never,
    repository as never,
    audit as never,
    config(isProduction),
  );
  return { service, repository };
}

describe('placeholder payment methods', () => {
  const realDetails = {
    walletProvider: 'vodafone_cash' as const,
    walletNumber: '010 1234 5678',
    accountName: 'Ziad Gehad',
    instructions: 'Send the exact amount.',
    referenceInstructions: 'Use your organization name.',
  };

  it('in production, a placeholder cannot be enabled as it is', async () => {
    const { service, repository } = platformService(true);
    await expect(service.update('po', 'm1', { enabled: true })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('in production, saving real details with it enables it and drops the placeholder', async () => {
    const { service, repository } = platformService(true);
    const result = await service.update('po', 'm1', {
      enabled: true,
      walletInstructions: realDetails,
    });
    expect(result.enabled).toBe(true);
    expect(result.manualInstructions).toMatchObject({ walletNumber: '01012345678' });
    expect(
      (result.manualInstructions as { placeholder?: boolean }).placeholder,
    ).toBeUndefined();
    expect(repository.update).toHaveBeenCalledTimes(1);
  });

  it('outside production, a placeholder can be enabled for testing', async () => {
    const { service } = platformService(false);
    await expect(service.update('po', 'm1', { enabled: true })).resolves.toMatchObject({
      enabled: true,
    });
  });

  it('in production, no payment is taken against a placeholder method', async () => {
    const tx = {};
    const service = Object.create(PaymentService.prototype) as PaymentService;
    Object.assign(service, {
      tenancyContextService: {
        runInTenantContext: (_org: string, fn: (t: object) => unknown) => fn(tx),
      },
      checkoutsRepository: {
        lockForPayment: jest.fn(),
        findById: jest.fn().mockResolvedValue({
          id: 'c1',
          status: 'pending_payment',
          expiresAt: new Date(Date.now() + 60_000),
        }),
      },
      paymentMethodsRepository: {
        findByKey: jest.fn().mockResolvedValue({ ...PLACEHOLDER, enabled: true }),
      },
      paymentsRepository: { findOpenForCheckout: jest.fn(), create: jest.fn() },
      configService: config(true),
    });
    await expect(
      service.createPayment('org1', { checkoutId: 'c1', methodKey: PLACEHOLDER.key }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      (service as unknown as { paymentsRepository: { create: jest.Mock } })
        .paymentsRepository.create,
    ).not.toHaveBeenCalled();
  });
});
