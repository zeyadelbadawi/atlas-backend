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
}
