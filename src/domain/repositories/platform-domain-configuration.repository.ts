/**
 * PlatformDomainConfigurationRepository — `platform_domain_configuration`
 * is a PLATFORM-owned singleton, no RLS, no tenant context — mirrors
 * `TrialPolicyRepository` exactly: a fixed, well-known id and `upsert`
 * close the concurrent-first-read race atomically at the database level.
 */
import { Injectable } from '@nestjs/common';
import type { PlatformDomainConfiguration } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

/** Fixed, well-known id — never generated, never varies. The one row this table will ever have. */
const SINGLETON_ID = '00000000-0000-0000-0000-000000000002';

@Injectable()
export class PlatformDomainConfigurationRepository {
  constructor(private readonly prisma: PrismaService) {}

  findSingleton(): Promise<PlatformDomainConfiguration> {
    return this.prisma.platformDomainConfiguration.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, baseDomain: null, configured: false },
      update: {},
    });
  }

  update(baseDomain: string): Promise<PlatformDomainConfiguration> {
    return this.prisma.platformDomainConfiguration.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, baseDomain, configured: true },
      update: { baseDomain, configured: true },
    });
  }

  /** P63g — the verification sweep's last completed tick (platform-owned singleton, no RLS: written by the sweep, read by readiness). */
  recordSweep(
    completedAt: Date,
    result: Record<string, number | string | boolean | null>,
  ): Promise<PlatformDomainConfiguration> {
    return this.prisma.platformDomainConfiguration.upsert({
      where: { id: SINGLETON_ID },
      create: {
        id: SINGLETON_ID,
        baseDomain: null,
        configured: false,
        lastSweepCompletedAt: completedAt,
        lastSweepResult: result,
      },
      update: { lastSweepCompletedAt: completedAt, lastSweepResult: result },
    });
  }

  /** P63g — pending provider releases, counted through the RLS-bypassing definer function (the readiness view runs outside any tenant context). */
  async countPendingReleases(): Promise<number> {
    const rows = await this.prisma.$queryRaw<
      { count: bigint }[]
    >`SELECT count_pending_domain_releases() AS count`;
    return Number(rows[0]?.count ?? 0);
  }
}
