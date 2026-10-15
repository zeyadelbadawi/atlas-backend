/**
 * AcademyArchiveModule (D5-2) — provides `AcademyArchiveService`, the one
 * implementation of archiving an academy, to both of its callers:
 * `AcademyModule` (`DELETE /academies/:id`) and `IdentityModule` (account
 * deletion archiving the academies of every organization the person owns).
 *
 * WHY A MODULE OF ITS OWN. `AcademyModule` imports `IdentityModule`, so
 * account deletion cannot reach `AcademiesService` without a module cycle.
 * This module imports neither: it depends only on `TenancyModule` (which
 * itself depends only on `AuthCoreModule`) and registers the rest DIRECTLY
 * — every one a stateless wrapper over the `@Global()` Prisma, Redis,
 * configuration or the BullMQ connection, the same no-cycle approach
 * `AcademyModule` already records for its own domain providers. Both
 * importers therefore stay a clean DAG with no `forwardRef`.
 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AcademyArchiveService } from './services/academy-archive.service';
import { UsersRepository } from '../identity/repositories/users.repository';
import { TenantUsageRecomputeProducer } from '../plans/queue/tenant-usage-recompute.producer';
import { TENANT_USAGE_RECOMPUTE_QUEUE } from '../plans/queue/tenant-usage-recompute.types';
import { SubdomainAllocationsRepository } from '../domain/repositories/subdomain-allocations.repository';
import { DomainConnectionsRepository } from '../domain/repositories/domain-connections.repository';
import { DomainProviderReleasesRepository } from '../domain/repositories/domain-provider-releases.repository';
import { DomainProviderReleaseService } from '../domain/services/domain-provider-release.service';
import { PlatformDomainService } from '../domain/services/platform-domain.service';
import { HttpsProbeService } from '../domain/services/https-probe.service';
import { CLOUDFLARE_PROVIDER } from '../domain/providers/cloudflare-provider.interface';
import { CloudflareApiProvider } from '../domain/providers/cloudflare-api.provider';
import { PlatformDomainConfigurationRepository } from '../domain/repositories/platform-domain-configuration.repository';
import { PublicWebsiteCacheService } from '../public-website/services/public-website-cache.service';

@Module({
  imports: [
    TenancyModule,
    // The producer's queue; registering a queue in more than one module is
    // how `CERTIFICATE_JOBS_QUEUE` is already shared.
    BullModule.registerQueue({ name: TENANT_USAGE_RECOMPUTE_QUEUE }),
  ],
  providers: [
    AcademyArchiveService,
    UsersRepository,
    TenantUsageRecomputeProducer,
    SubdomainAllocationsRepository,
    PlatformDomainConfigurationRepository,
    DomainConnectionsRepository,
    DomainProviderReleasesRepository,
    DomainProviderReleaseService,
    PlatformDomainService,
    HttpsProbeService,
    { provide: CLOUDFLARE_PROVIDER, useClass: CloudflareApiProvider },
    PublicWebsiteCacheService,
  ],
  exports: [AcademyArchiveService],
})
export class AcademyArchiveModule {}
