/**
 * DomainModule — Phase P11 (master plan §21), extended P63.
 *
 * Wires Academy domain management (`DomainService`), the platform base
 * domain and infrastructure readiness (`PlatformDomainService`), the
 * Platform Owner domain operations console (`PlatformDomainsService`),
 * the shared provider check (`DomainCheckService` + `HttpsProbeService`),
 * the verification sweep (one BullMQ repeatable), infrastructure-provider
 * status (`InfrastructureService`), and the real `CloudflareProvider`.
 *
 * Imports `AuthCoreModule` (for `JwtAuthGuard`), `IdentityModule` (for
 * `PlatformOwnerGuard`/`UsersRepository`), `TenancyModule`
 * (`TenancyContextService`) and `AcademyModule`
 * (`AcademyScopeGuard`/`AcademyMembersRepository`). `AuditLogModule` is
 * global. `PublicWebsiteCacheService` is a stateless Redis facade
 * provided directly, exactly as `AcademyModule`/`BillingModule` do —
 * importing `PublicWebsiteModule` here would form a cycle
 * (PublicWebsite → Academy → Domain).
 *
 * `PlatformDomainConfigurationRepository`/`SubdomainAllocationsRepository`
 * remain exported for `ProvisioningModule`/`AcademyModule` (P14).
 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AcademyModule } from '../academy/academy.module';
import { PublicWebsiteCacheService } from '../public-website/services/public-website-cache.service';
import { DomainController } from './controllers/domain.controller';
import { PlatformDomainController } from './controllers/platform-domain.controller';
import { PlatformDomainsController } from './controllers/platform-domains.controller';
import { InfrastructureController } from './controllers/infrastructure.controller';
import { DomainService } from './services/domain.service';
import { DomainCheckService } from './services/domain-check.service';
import { HttpsProbeService } from './services/https-probe.service';
import { PlatformDomainService } from './services/platform-domain.service';
import { PlatformDomainsService } from './services/platform-domains.service';
import { DomainVerificationSweepService } from './services/domain-verification-sweep.service';
import { InfrastructureService } from './services/infrastructure.service';
import { SubdomainAllocationsRepository } from './repositories/subdomain-allocations.repository';
import { DomainConnectionsRepository } from './repositories/domain-connections.repository';
import { DomainProviderReleasesRepository } from './repositories/domain-provider-releases.repository';
import { DomainProviderReleaseService } from './services/domain-provider-release.service';
import { PlatformDomainConfigurationRepository } from './repositories/platform-domain-configuration.repository';
import { CLOUDFLARE_PROVIDER } from './providers/cloudflare-provider.interface';
import { CloudflareApiProvider } from './providers/cloudflare-api.provider';
import { DomainVerificationSweepProcessor } from './queue/domain-verification-sweep.processor';
import { DomainVerificationSweepScheduler } from './queue/domain-verification-sweep.scheduler';
import { DOMAIN_VERIFICATION_SWEEP_QUEUE } from './queue/domain-verification-sweep.types';

@Module({
  imports: [
    AuthCoreModule,
    IdentityModule,
    TenancyModule,
    AcademyModule,
    BullModule.registerQueue({ name: DOMAIN_VERIFICATION_SWEEP_QUEUE }),
  ],
  controllers: [
    DomainController,
    PlatformDomainController,
    PlatformDomainsController,
    InfrastructureController,
  ],
  providers: [
    DomainService,
    DomainCheckService,
    HttpsProbeService,
    PlatformDomainService,
    PlatformDomainsService,
    DomainVerificationSweepService,
    DomainVerificationSweepProcessor,
    DomainVerificationSweepScheduler,
    InfrastructureService,
    SubdomainAllocationsRepository,
    DomainConnectionsRepository,
    DomainProviderReleasesRepository,
    DomainProviderReleaseService,
    PlatformDomainConfigurationRepository,
    PublicWebsiteCacheService,
    { provide: CLOUDFLARE_PROVIDER, useClass: CloudflareApiProvider },
  ],
  exports: [
    SubdomainAllocationsRepository,
    DomainConnectionsRepository,
    DomainProviderReleasesRepository,
    PlatformDomainConfigurationRepository,
    PlatformDomainService,
  ],
})
export class DomainModule {}
