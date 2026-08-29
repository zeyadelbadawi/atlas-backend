/**
 * ProvisioningModule — Phase P14 (master plan §21). Wires the 7-step
 * resumable provisioning state machine: `provisioning_requests`/
 * `provisioning_steps`, the org-scoped and Platform Owner review
 * surfaces, the global subdomain-availability check, and the
 * `provisioning-worker` BullMQ queue.
 *
 * Deliberately its OWN module, not folded into `AcademyModule` or
 * `DomainModule` — this phase genuinely needs providers from BOTH
 * (`AcademiesService`/`AcademiesRepository` from Academy; the P11
 * subdomain/domain repositories from Domain) plus `PaymentsRepository`
 * from Billing, and either of those importing the other to reach the rest
 * would create the exact module-DAG cycle `CourseCommerceModule`'s own
 * doc comment already established the precedent for avoiding — a new
 * phase module that imports every dependency it needs and invents none of
 * their logic a second time, the same pattern every prior phase used.
 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AcademyModule } from '../academy/academy.module';
import { DomainModule } from '../domain/domain.module';
import { BillingModule } from '../billing/billing.module';
import { PlansModule } from '../plans/plans.module';
import { WebsiteModule } from '../website/website.module';
import { ProvisioningRequestsController } from './controllers/provisioning-requests.controller';
import { PlatformProvisioningController } from './controllers/platform-provisioning.controller';
import { SubdomainAvailabilityController } from './controllers/subdomain-availability.controller';
import { ProvisioningRequestsService } from './services/provisioning-requests.service';
import { PlatformProvisioningService } from './services/platform-provisioning.service';
import { ProvisioningOrchestratorService } from './services/provisioning-orchestrator.service';
import { SubdomainAvailabilityService } from './services/subdomain-availability.service';
import { ProvisioningRequestsRepository } from './repositories/provisioning-requests.repository';
import { ProvisioningStepsRepository } from './repositories/provisioning-steps.repository';
import { ProvisioningProducer } from './queue/provisioning.producer';
import { ProvisioningProcessor } from './queue/provisioning.processor';
import { PROVISIONING_QUEUE } from './queue/provisioning.types';

@Module({
  imports: [
    AuthCoreModule,
    IdentityModule,
    TenancyModule,
    AcademyModule,
    DomainModule,
    BillingModule,
    // Phase P19 additions: `PlansModule` for `TenantSubscriptionsRepository`
    // (the payment-gate check — see `ProvisioningRequestsService.
    // createRequest`'s own comment); `WebsiteModule` for
    // `WebsiteConfigurationService` (the real 'theme' provisioning step —
    // see `ProvisioningOrchestratorService.executeStep`'s 'theme' case).
    // Neither creates a cycle: `PlansModule` imports only
    // `AuthCoreModule`/`IdentityModule`/`TenancyModule`; `WebsiteModule`
    // imports only `AuthCoreModule`/`TenancyModule`/`AcademyModule`/
    // `CourseModule` — none of which import `ProvisioningModule`.
    PlansModule,
    WebsiteModule,
    BullModule.registerQueue({ name: PROVISIONING_QUEUE }),
  ],
  controllers: [
    ProvisioningRequestsController,
    PlatformProvisioningController,
    SubdomainAvailabilityController,
  ],
  providers: [
    ProvisioningRequestsService,
    PlatformProvisioningService,
    ProvisioningOrchestratorService,
    SubdomainAvailabilityService,
    ProvisioningRequestsRepository,
    ProvisioningStepsRepository,
    ProvisioningProducer,
    ProvisioningProcessor,
  ],
  exports: [
    // Phase P15 — `PlatformAcademiesService` needs the same
    // `provisioning_requests` lookup-by-academy P14 already exposes for
    // its own platform-review surface, reusing this repository verbatim.
    ProvisioningRequestsRepository,
  ],
})
export class ProvisioningModule {}
