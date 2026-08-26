/**
 * AtlasSubscriptionPaymentProviderConfigRepository —
 * `atlas_subscription_payment_provider_config` is a PLATFORM-owned
 * singleton, no RLS, no tenant context — mirrors
 * `AtlasCommissionConfigRepository`/`PlatformDomainConfigurationRepository`
 * exactly: a fixed, well-known id and `upsert` close the concurrent-first-
 * read race atomically at the database level.
 *
 * `findForResponse` is the ONLY read method anything on a response path may
 * call — it deliberately omits `encryptedConfig` at the query level (a
 * Prisma `select`, not a post-hoc delete of the field), mirroring
 * `OrganizationGatewayCredentialsRepository`'s identical discipline.
 * `findWithEncryptedConfig` is separate and internal-only, used exclusively
 * by `AtlasSubscriptionPaymentProviderService.testConnection`/effective-
 * provider resolution.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AtlasSubscriptionPaymentProviderConfig } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

/** Fixed, well-known id — never generated, never varies. The one row this table will ever have. */
const SINGLETON_ID = '00000000-0000-0000-0000-0000000000a5';

export type AtlasSubscriptionPaymentProviderConfigSummary = Omit<
  AtlasSubscriptionPaymentProviderConfig,
  'encryptedConfig'
>;

const SUMMARY_SELECT = {
  id: true,
  providerKey: true,
  status: true,
  enabled: true,
  lastTestedAt: true,
  lastTestResult: true,
  updatedBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class AtlasSubscriptionPaymentProviderConfigRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Response-safe read — never selects `encryptedConfig`. Lazily materializes the singleton row on first read (matches `AtlasCommissionConfigRepository`'s own `upsert`-on-read precedent), so a Platform Owner who has never touched this setting still reads a real, honest `not_configured` row rather than nothing at all. */
  findForResponse(): Promise<AtlasSubscriptionPaymentProviderConfigSummary> {
    return this.prisma.atlasSubscriptionPaymentProviderConfig.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID },
      update: {},
      select: SUMMARY_SELECT,
    });
  }

  /** Internal-only — the encrypted blob, for `testConnection`/effective-provider resolution's decrypt-and-call use only. Never call this from anything that maps a result into an HTTP response. */
  findWithEncryptedConfig(): Promise<AtlasSubscriptionPaymentProviderConfig> {
    return this.prisma.atlasSubscriptionPaymentProviderConfig.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID },
      update: {},
    });
  }

  upsertProvider(data: {
    readonly providerKey: string;
    readonly encryptedConfig: string;
    readonly updatedBy: string;
  }): Promise<AtlasSubscriptionPaymentProviderConfigSummary> {
    return this.prisma.atlasSubscriptionPaymentProviderConfig.upsert({
      where: { id: SINGLETON_ID },
      create: {
        id: SINGLETON_ID,
        providerKey: data.providerKey,
        encryptedConfig: data.encryptedConfig,
        status: 'configured',
        enabled: false,
        updatedBy: data.updatedBy,
      },
      update: {
        providerKey: data.providerKey,
        encryptedConfig: data.encryptedConfig,
        status: 'configured',
        // Changing the configuration invalidates any prior verification —
        // never carry a stale `verified` status or a stale test result
        // forward across a credential change (matches
        // `OrganizationGatewayCredentialsRepository.upsert`'s identical rule).
        enabled: false,
        lastTestedAt: null,
        lastTestResult: Prisma.JsonNull,
        updatedBy: data.updatedBy,
      },
      select: SUMMARY_SELECT,
    });
  }

  recordTestResult(result: {
    readonly success: boolean;
    readonly message?: string;
  }): Promise<AtlasSubscriptionPaymentProviderConfigSummary> {
    return this.prisma.atlasSubscriptionPaymentProviderConfig.update({
      where: { id: SINGLETON_ID },
      data: {
        status: result.success ? 'verified' : 'configured',
        lastTestedAt: new Date(),
        lastTestResult: result as unknown as Prisma.InputJsonValue,
      },
      select: SUMMARY_SELECT,
    });
  }

  setEnabled(
    enabled: boolean,
    updatedBy: string,
  ): Promise<AtlasSubscriptionPaymentProviderConfigSummary> {
    return this.prisma.atlasSubscriptionPaymentProviderConfig.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, enabled, updatedBy },
      update: { enabled, updatedBy },
      select: SUMMARY_SELECT,
    });
  }
}
