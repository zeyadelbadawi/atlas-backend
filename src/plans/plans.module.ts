/**
 * PlansModule — Phase P4 (master plan §21). Wires the catalog
 * (`plans`/`add-ons`/`trial-policy`, platform-owned, no RLS), the tenant
 * subscription/usage/add-on read surface (organization-scoped, RLS-
 * protected), the entitlement computation engine, and the
 * `tenant-usage-recompute` worker.
 *
 * Imports `AuthCoreModule` (for `JwtAuthGuard`), `IdentityModule` (for
 * `PlatformOwnerGuard`, reused verbatim), and `TenancyModule` (for
 * `TenancyContextService` and `OrganizationMembershipGuard`, also reused
 * verbatim, unmodified) — same DAG-cleanliness reasoning as
 * `AcademyModule`, and the same "reuse P1/P2's existing mechanisms, never
 * duplicate them" rule.
 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { PlansController } from './controllers/plans.controller';
import { AddOnsController } from './controllers/add-ons.controller';
import { TrialPolicyController } from './controllers/trial-policy.controller';
import { TenantSubscriptionController } from './controllers/tenant-subscription.controller';
import { PlansService } from './services/plans.service';
import { TenantSubscriptionService } from './services/tenant-subscription.service';
import { EntitlementService } from './services/entitlement.service';
import { TenantUsageRecomputeService } from './services/tenant-usage-recompute.service';
import { PlansRepository } from './repositories/plans.repository';
import { AddOnsRepository } from './repositories/add-ons.repository';
import { TrialPolicyRepository } from './repositories/trial-policy.repository';
import { TenantSubscriptionsRepository } from './repositories/tenant-subscriptions.repository';
import { TenantAddOnsRepository } from './repositories/tenant-add-ons.repository';
import { TenantUsageRepository } from './repositories/tenant-usage.repository';
import { TenantUsageRecomputeProducer } from './queue/tenant-usage-recompute.producer';
import { TenantUsageRecomputeProcessor } from './queue/tenant-usage-recompute.processor';
import { TENANT_USAGE_RECOMPUTE_QUEUE } from './queue/tenant-usage-recompute.types';

@Module({
  imports: [
    AuthCoreModule,
    // `PlatformOwnerGuard` (for `PATCH /trial-policy`) is exported by
    // `IdentityModule`, not `AuthCoreModule` — see that guard's own doc
    // comment for why it lives there. Importing `IdentityModule` here
    // introduces no cycle: `IdentityModule` already depends on
    // `TenancyModule`, and nothing in `IdentityModule`/`TenancyModule`
    // depends on `PlansModule`.
    IdentityModule,
    TenancyModule,
    BullModule.registerQueue({ name: TENANT_USAGE_RECOMPUTE_QUEUE }),
  ],
  controllers: [
    PlansController,
    AddOnsController,
    TrialPolicyController,
    TenantSubscriptionController,
  ],
  providers: [
    PlansService,
    TenantSubscriptionService,
    EntitlementService,
    TenantUsageRecomputeService,
    PlansRepository,
    AddOnsRepository,
    TrialPolicyRepository,
    TenantSubscriptionsRepository,
    TenantAddOnsRepository,
    TenantUsageRepository,
    TenantUsageRecomputeProducer,
    TenantUsageRecomputeProcessor,
  ],
  exports: [
    EntitlementService,
    TenantUsageRecomputeService,
    // P12 additions — `BillingModule` needs the catalog lookups
    // (`PlansRepository`/`AddOnsRepository`, to resolve a Checkout's
    // `targetKey` against a real Plan/AddOn) and the two write methods
    // `CheckoutService`/`PaymentApplicationService` call when a Payment
    // succeeds (`TenantSubscriptionsRepository.updateForPlanPurchase`,
    // `TenantAddOnsRepository.activate`) — reusing these repositories
    // directly, rather than duplicating `plans`/`tenant_subscriptions`/
    // `tenant_add_ons` data access inside `src/billing/`, matches this
    // codebase's "one shared definition, not a second copy" rule.
    PlansRepository,
    AddOnsRepository,
    TenantSubscriptionsRepository,
    TenantAddOnsRepository,
    // Phase P15 — `PlatformOrganizationsService` needs the exact same
    // `getSubscription`/`getUsage` reads a Tenant's own dashboard already
    // performs (full entitlement-aware `TenantUsageResponse` assembly),
    // for one already-resolved `organizationId` — reusing this service
    // verbatim (it already re-establishes its own `runInTenantContext`)
    // rather than re-deriving entitlements a second time.
    TenantSubscriptionService,
  ],
})
export class PlansModule {}
