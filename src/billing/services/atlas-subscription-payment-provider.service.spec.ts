import { ConflictException, NotFoundException } from '@nestjs/common';
import { AtlasSubscriptionPaymentProviderService } from './atlas-subscription-payment-provider.service';
import { ManualTransferProvider } from '../providers/manual-transfer.provider';
import { PaymentProviderRegistry } from '../providers/payment-provider.registry';
import type { AtlasSubscriptionPaymentProviderConfigRepository } from '../repositories/atlas-subscription-payment-provider-config.repository';
import type { CredentialEncryptionService } from '../utils/credential-encryption.util';
import type { AtlasSubscriptionPaymentProviderStatus } from '@prisma/client';

const BASE_ROW = {
  id: 'singleton',
  providerKey: null as string | null,
  status: 'not_configured' as AtlasSubscriptionPaymentProviderStatus,
  enabled: false,
  lastTestedAt: null,
  lastTestResult: null,
  updatedBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function buildService(
  overrides: {
    row?: Partial<typeof BASE_ROW & { encryptedConfig: string | null }>;
    encryptSpy?: jest.Mock;
    decryptSpy?: jest.Mock;
  } = {},
) {
  const row = { ...BASE_ROW, encryptedConfig: null, ...overrides.row };
  const repository = {
    findForResponse: jest.fn().mockResolvedValue(row),
    findWithEncryptedConfig: jest.fn().mockResolvedValue(row),
    upsertProvider: jest.fn().mockResolvedValue({ ...row, status: 'configured' }),
    recordTestResult: jest
      .fn()
      .mockImplementation((result) =>
        Promise.resolve({ ...row, status: result.success ? 'verified' : 'configured' }),
      ),
    setEnabled: jest
      .fn()
      .mockImplementation((enabled) => Promise.resolve({ ...row, enabled })),
  } as unknown as AtlasSubscriptionPaymentProviderConfigRepository;

  const registry = new PaymentProviderRegistry(new ManualTransferProvider());

  const encryption = {
    encrypt: overrides.encryptSpy ?? jest.fn().mockReturnValue('encrypted-blob'),
    decrypt: overrides.decryptSpy ?? jest.fn().mockReturnValue('{}'),
  } as unknown as CredentialEncryptionService;

  return {
    service: new AtlasSubscriptionPaymentProviderService(
      repository,
      registry,
      encryption,
    ),
    repository,
    registry,
  };
}

describe('AtlasSubscriptionPaymentProviderService', () => {
  it('resolves the effective provider to Manual Transfer when nothing has ever been configured', async () => {
    const { service } = buildService();
    const config = await service.getConfig();
    expect(config.effectiveProviderKey).toBe('atlas_manual');
    expect(config.effectiveProviderDisplayName).toBe('Manual Transfer');
    expect(config.providerKey).toBeNull();
  });

  it('resolves the effective provider to Manual Transfer when a provider is configured but disabled', async () => {
    const { service } = buildService({
      row: { providerKey: 'future_gateway', enabled: false },
    });
    const config = await service.getConfig();
    expect(config.effectiveProviderKey).toBe('atlas_manual');
  });

  it('rejects saving a provider key that is not registered as available for Atlas Subscription selection', async () => {
    const { service } = buildService();
    await expect(
      service.saveConfig('platform-owner-1', { providerKey: 'stripe', config: {} }),
    ).rejects.toThrow(ConflictException);
  });

  it('encrypts the provided config before persisting — plaintext never reaches the repository call', async () => {
    const encryptSpy = jest.fn().mockReturnValue('encrypted-blob');
    const { service, repository } = buildService({ encryptSpy });

    await service.saveConfig('platform-owner-1', {
      providerKey: 'atlas_manual',
      config: { secret: 'super-secret-value' },
    });

    expect(encryptSpy).toHaveBeenCalledWith(
      JSON.stringify({ secret: 'super-secret-value' }),
    );
    const upsertCall = (repository.upsertProvider as jest.Mock).mock.calls[0][0];
    expect(upsertCall.encryptedConfig).toBe('encrypted-blob');
    expect(JSON.stringify(upsertCall)).not.toContain('super-secret-value');
  });

  it('testConnection throws NotFound when nothing has been configured yet', async () => {
    const { service } = buildService();
    await expect(service.testConnection()).rejects.toThrow(NotFoundException);
  });

  it('setEnabled(true) is rejected until the configuration has been verified', async () => {
    const { service } = buildService({ row: { status: 'configured' } });
    await expect(service.setEnabled('platform-owner-1', true)).rejects.toThrow(
      ConflictException,
    );
  });

  it('setEnabled(true) succeeds once verified', async () => {
    const { service } = buildService({ row: { status: 'verified' } });
    await expect(service.setEnabled('platform-owner-1', true)).resolves.toMatchObject({
      enabled: true,
    });
  });

  it('resolveEffectiveProviderForPaymentIntent returns null when unconfigured — the exact P12-unchanged path', async () => {
    const { service } = buildService();
    await expect(service.resolveEffectiveProviderForPaymentIntent()).resolves.toBeNull();
  });

  it('resolveEffectiveProviderForPaymentIntent returns null when configured+enabled+verified but the resolved adapter has no createPaymentIntent capability (ManualTransferProvider today)', async () => {
    const { service } = buildService({
      row: {
        providerKey: 'atlas_manual',
        enabled: true,
        status: 'verified',
        encryptedConfig: 'encrypted-blob',
      },
    });
    await expect(service.resolveEffectiveProviderForPaymentIntent()).resolves.toBeNull();
  });

  it('resolveEffectiveProviderForPaymentIntent returns null for a disabled configuration even if otherwise verified', async () => {
    const { service } = buildService({
      row: {
        providerKey: 'atlas_manual',
        enabled: false,
        status: 'verified',
        encryptedConfig: 'encrypted-blob',
      },
    });
    await expect(service.resolveEffectiveProviderForPaymentIntent()).resolves.toBeNull();
  });
});
