/**
 * DomainModule — Phase P11 (master plan §21). Wires Academy domain
 * management (`DomainService`), Platform base-domain configuration
 * (`PlatformDomainService`), infrastructure-provider status
 * (`InfrastructureService`), and the real `CloudflareProvider` adapter.
 *
 * Imports `AuthCoreModule` (for `JwtAuthGuard`), `IdentityModule` (for
 * `PlatformOwnerGuard` and its own dependency `UsersRepository` — both
 * exported from there, NOT `AuthCoreModule`; mirrors `PlansModule`'s
 * identical import pair for `TrialPolicyController`, the exact same
 * guard combination), `TenancyModule` (for `TenancyContextService`), and
 * `AcademyModule` (for `AcademyScopeGuard`/`AcademyMembersRepository`,
 * reused verbatim).
 *
 * `PlatformDomainConfigurationRepository` is additionally exported as of
 * Phase P14 — `ProvisioningModule`'s `subdomain` orchestration step needs
 * the Platform's configured `baseDomain` to compute a real `fullHost`.
 * `SubdomainAllocationsRepository` was already exported (P11); this table
 * is its real first writer (see that repository's own updated doc
 * comment).
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AcademyModule } from '../academy/academy.module';
import { DomainController } from './controllers/domain.controller';
import { PlatformDomainController } from './controllers/platform-domain.controller';
import { InfrastructureController } from './controllers/infrastructure.controller';
import { DomainService } from './services/domain.service';
import { PlatformDomainService } from './services/platform-domain.service';
import { InfrastructureService } from './services/infrastructure.service';
import { SubdomainAllocationsRepository } from './repositories/subdomain-allocations.repository';
import { DomainConnectionsRepository } from './repositories/domain-connections.repository';
import { PlatformDomainConfigurationRepository } from './repositories/platform-domain-configuration.repository';
import { CLOUDFLARE_PROVIDER } from './providers/cloudflare-provider.interface';
import { CloudflareApiProvider } from './providers/cloudflare-api.provider';

@Module({
  imports: [AuthCoreModule, IdentityModule, TenancyModule, AcademyModule],
  controllers: [DomainController, PlatformDomainController, InfrastructureController],
  providers: [
    DomainService,
    PlatformDomainService,
    InfrastructureService,
    SubdomainAllocationsRepository,
    DomainConnectionsRepository,
    PlatformDomainConfigurationRepository,
    { provide: CLOUDFLARE_PROVIDER, useClass: CloudflareApiProvider },
  ],
  exports: [
    SubdomainAllocationsRepository,
    DomainConnectionsRepository,
    PlatformDomainConfigurationRepository,
  ],
})
export class DomainModule {}
