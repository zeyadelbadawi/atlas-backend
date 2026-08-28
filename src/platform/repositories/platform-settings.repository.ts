/**
 * PlatformSettingsRepository — `platform_settings` is a PLATFORM-owned
 * singleton, no RLS, no tenant context — mirrors
 * `PlatformDomainConfigurationRepository`/`TrialPolicyRepository` exactly:
 * a fixed, well-known id and `upsert` close the concurrent-first-read
 * race atomically at the database level. `PlatformOwnerGuard` at the
 * controller is the real, sufficient protection (see the P15 migration's
 * own doc comment for why this table has no RLS).
 *
 * `update` accepts an explicit Prisma client (either the raw
 * `PrismaService` or a `$transaction`'s own `tx`) rather than always
 * using its own injected `this.prisma` — `PlatformSettingsService.
 * updateConfiguration` needs the settings write and the audit-log write
 * to share one transaction (this phase's own atomicity rule), so it opens
 * its own `$transaction` and passes that `tx` in here.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma, PlatformSettings } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

/** Fixed, well-known id — never generated, never varies. The one row this table will ever have. */
export const PLATFORM_SETTINGS_SINGLETON_ID = '00000000-0000-0000-0000-000000000003';

/** The real, honest defaults — no invented copy. `platformName` is the one required field on the frontend's `PlatformConfiguration`, so it needs a real starting value; everything else defaults to its own honest empty/off state. */
const DEFAULTS = {
  id: PLATFORM_SETTINGS_SINGLETON_ID,
  platformName: 'Atlas',
  platformDescription: null,
  supportEmail: null,
  twoFactorRequired: false,
  sessionTimeoutMinutes: null,
} as const;

type PrismaClientLike = PrismaService | Prisma.TransactionClient;

@Injectable()
export class PlatformSettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findSingleton(): Promise<PlatformSettings> {
    return this.prisma.platformSettings.upsert({
      where: { id: PLATFORM_SETTINGS_SINGLETON_ID },
      create: DEFAULTS,
      update: {},
    });
  }

  update(
    client: PrismaClientLike,
    data: Partial<Omit<Prisma.PlatformSettingsUncheckedCreateInput, 'id'>>,
  ): Promise<PlatformSettings> {
    return client.platformSettings.upsert({
      where: { id: PLATFORM_SETTINGS_SINGLETON_ID },
      create: { ...DEFAULTS, ...data },
      update: data,
    });
  }
}
