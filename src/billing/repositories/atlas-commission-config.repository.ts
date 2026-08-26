/**
 * AtlasCommissionConfigRepository — `atlas_commission_config` is a
 * PLATFORM-owned singleton, no RLS, no tenant context — mirrors
 * `PlatformDomainConfigurationRepository` (P11) exactly: a fixed,
 * well-known id and `upsert` close the concurrent-first-read race
 * atomically at the database level.
 */
import { Injectable } from '@nestjs/common';
import type { AtlasCommissionConfig } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

/** Fixed, well-known id — never generated, never varies. The one row this table will ever have. */
const SINGLETON_ID = '00000000-0000-0000-0000-0000000000c1';

@Injectable()
export class AtlasCommissionConfigRepository {
  constructor(private readonly prisma: PrismaService) {}

  findSingleton(): Promise<AtlasCommissionConfig> {
    return this.prisma.atlasCommissionConfig.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, defaultCommissionBasisPoints: null },
      update: {},
    });
  }

  /** `defaultCommissionBasisPoints` is deliberately settable to a real integer only — this repository has no "unset" path, matching §4.2's "deliberately unset at creation" being a one-way transition into configured, not a toggle. */
  setDefault(
    defaultCommissionBasisPoints: number,
    updatedBy: string,
  ): Promise<AtlasCommissionConfig> {
    return this.prisma.atlasCommissionConfig.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, defaultCommissionBasisPoints, updatedBy },
      update: { defaultCommissionBasisPoints, updatedBy },
    });
  }
}
