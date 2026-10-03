/**
 * PlansModule — Phase P4 (master plan §21). Wires the catalog
 * (`plans`/`add-ons`/`trial-policy`, platform-owned, no RLS), the tenant
 * subscription/usage/add-on read surface (organization-scoped, RLS-
 * protected), the entitlement computation engine, and the
 * `tenant-usage-recompute` worker.
 *
 * Imports `AuthCoreModule` (for `JwtAuthGuard`), `IdentityModule` (for
 * `PlatformOwnerGuard`, reused verbatim, and — Phase 2 — `UsersRepository`,
 * needed by the subscription-sweep jobs to resolve a platform-owner id to
 * run under), and `TenancyModule` (for `TenancyContextService` and
 * `OrganizationMembershipGuard`, also reused verbatim, unmodified) — same
 * DAG-cleanliness reasoning as `AcademyModule`, and the same "reuse P1/P2's
 * existing mechanisms, never duplicate them" rule.
 *
 * Phase 2 (master plan §21 Phase P22, "Entitlement & Plan Enforcement")
 * additions: `EntitlementEnforcementService` (the live, write-time
 * authority every plan-limited write path now calls — exported so
 * `AcademyModule`/`CourseModule`/`LearningModule`/`MediaModule` can inject
 * it without duplicating entitlement logic), `SubscriptionExpiryService`
 * + `SubscriptionSweepService` + the new `subscription-sweep` BullMQ queue
 * (one repeatable job, registered by `SubscriptionSweepScheduler`, driving
 * both trial expiry and the usage-recompute safety net — see that
 * scheduler's own doc comment for why this is ONE mechanism, not two).
 */
import { Module } from '@nestjs/common';
import { VideoTierService } from './services/video-tier.service';
import { BullModule } from '@nestjs/bullmq';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { CommunityModule } from '../community/community.module';
import { PlansController } from './controllers/plans.controller';
import { PublicPlansController } from './controllers/public-plans.controller';
import { AddOnsController } from './controllers/add-ons.controller';
import { TrialPolicyController } from './controllers/trial-policy.controller';
import { TenantSubscriptionController } from './controllers/tenant-subscription.controller';
import { OrganizationsController } from './controllers/organizations.controller';
import { PlansService } from './services/plans.service';
import { TenantSubscriptionService } from './services/tenant-subscription.service';
import { EntitlementService } from './services/entitlement.service';
import { EntitlementEnforcementService } from './services/entitlement-enforcement.service';
import { SubscriptionAccessService } from './services/subscription-access.service';
import { PublicHostnameResolutionRepository } from '../public-website/repositories/public-hostname-resolution.repository';
import { PublicWebsiteCacheService } from '../public-website/services/public-website-cache.service';
import { PLANS_CLOCK, SystemClock } from './utils/clock';
import { TenantUsageRecomputeService } from './services/tenant-usage-recompute.service';
import { SubscriptionExpiryService } from './services/subscription-expiry.service';
import { SubscriptionSweepService } from './services/subscription-sweep.service';
import { TenantLifecycleService } from './services/tenant-lifecycle.service';
import { OrganizationSubscriptionBootstrapService } from './services/organization-subscription-bootstrap.service';
import { TrialEligibilityService } from './services/trial-eligibility.service';
import { CustomerIdentityHasher } from './services/customer-identity-hasher.service';
import { PaidGiftEligibilityService } from './services/paid-gift-eligibility.service';
import { TrialRedemptionService } from './services/trial-redemption.service';
import { PlansRepository } from './repositories/plans.repository';
import { AddOnsRepository } from './repositories/add-ons.repository';
import { TrialPolicyRepository } from './repositories/trial-policy.repository';
import { TenantSubscriptionsRepository } from './repositories/tenant-subscriptions.repository';
import { TenantAddOnsRepository } from './repositories/tenant-add-ons.repository';
import { TenantUsageRepository } from './repositories/tenant-usage.repository';
import { TenantUsageSweepCursorRepository } from './repositories/tenant-usage-sweep-cursor.repository';
import { TenantLifecycleStateRepository } from './repositories/tenant-lifecycle-state.repository';
import { TenantUsageRecomputeProducer } from './queue/tenant-usage-recompute.producer';
import { TenantUsageRecomputeProcessor } from './queue/tenant-usage-recompute.processor';
import { TENANT_USAGE_RECOMPUTE_QUEUE } from './queue/tenant-usage-recompute.types';
import { SubscriptionSweepProcessor } from './queue/subscription-sweep.processor';
import { SubscriptionSweepScheduler } from './queue/subscription-sweep.scheduler';
import { SUBSCRIPTION_SWEEP_QUEUE } from './queue/subscription-sweep.types';

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
    // Phase 6 — `AnnouncementsRepository`/`BlogPostsRepository`, needed by
    // `SubscriptionSweepService` to publish due scheduled content on the
    // same tick (see that service's own doc comment). No cycle:
    // `CommunityModule` only imports `AuthCoreModule`/`TenancyModule`,
    // neither of which import `PlansModule`.
    CommunityModule,
    BullModule.registerQueue(
      { name: TENANT_USAGE_RECOMPUTE_QUEUE },
      { name: SUBSCRIPTION_SWEEP_QUEUE },
    ),
  ],
  controllers: [
    PlansController,
    PublicPlansController,
    AddOnsController,
    TrialPolicyController,
    TenantSubscriptionController,
    // Phase 2 — relocated from `TenancyModule` (see that module's own doc
    // comment for why: it now needs
    // `OrganizationSubscriptionBootstrapService` alongside the reused,
    // unmodified `OrganizationsService`).
    OrganizationsController,
  ],
  providers: [
    // P64 Phase 2 (D10) — plan family → entitled video security tier.
    // Lives here because it reads the SUBSCRIPTION's plan, which is this
    // module's own data; `MediaModule` already depends on it one-way.
    VideoTierService,
    PlansService,
    TenantSubscriptionService,
    EntitlementService,
    EntitlementEnforcementService,
    SubscriptionAccessService,
    // Resolves `:academyId` to its Organization for the global
    // subscription interceptor — ownership only, never authorisation.
    PublicHostnameResolutionRepository,
    // Provided here rather than by importing `PublicWebsiteModule`, which
    // imports THIS module — the same reason `PublicHostnameResolutionRepository`
    // is listed directly. `RedisService` it depends on is global.
    PublicWebsiteCacheService,
    // The module's one clock. Production always gets real time; the
    // expiry-enforcement e2e suite overrides this token to stand exactly
    // 1 ms either side of a period end without sleeping.
    { provide: PLANS_CLOCK, useClass: SystemClock },
    TenantUsageRecomputeService,
    SubscriptionExpiryService,
    SubscriptionSweepService,
    // P64 C5 — the §26/§27 sequence evaluator, driven by the sweep above.
    // `CommunicationService` reaches it through the @Global
    // `CommunicationsModule`, so no import is added here and no cycle is
    // created (that module already imports `IdentityModule`/`TenancyModule`,
    // which this one also imports).
    TenantLifecycleService,
    TenantLifecycleStateRepository,
    OrganizationSubscriptionBootstrapService,
    TrialEligibilityService,
    TrialRedemptionService,
    // W8 — the one customer-identity hash (trial + gift ledgers) and the
    // gifted-setup-days authority `PaymentApplicationService` calls.
    CustomerIdentityHasher,
    PaidGiftEligibilityService,
    PlansRepository,
    AddOnsRepository,
    TrialPolicyRepository,
    TenantSubscriptionsRepository,
    TenantAddOnsRepository,
    TenantUsageRepository,
    TenantUsageSweepCursorRepository,
    TenantUsageRecomputeProducer,
    TenantUsageRecomputeProcessor,
    SubscriptionSweepProcessor,
    SubscriptionSweepScheduler,
  ],
  exports: [
    VideoTierService,
    EntitlementService,
    // Phase 2 — the live, write-time entitlement authority every
    // plan-limited write path (`AcademiesService.create`, course
    // creation, instructor grants, enrollment, media upload) now calls.
    EntitlementEnforcementService,
    // The global `SubscriptionAccessInterceptor` resolves this, so it has
    // to be visible outside this module even though nothing else imports
    // it directly.
    SubscriptionAccessService,
    TenantUsageRecomputeService,
    // Phase 2 — the real reactive trigger every academy/course/enrollment/
    // media write path now calls after a change that affects usage, so
    // the cached `tenant_usage` row stays current within moments rather
    // than only via the periodic safety-net sweep.
    TenantUsageRecomputeProducer,
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
    // New Customer Onboarding — `OnboardingModule` runs the signup's
    // organization + subscription + trial through these, verbatim, inside
    // the registration transaction, and derives the onboarding status's
    // trial availability from the same eligibility check.
    TrialRedemptionService,
    TrialEligibilityService,
    TrialPolicyRepository,
    OrganizationSubscriptionBootstrapService,
    // W8 — `BillingModule` claims gifted setup days inside the approval
    // transaction; scripts/tests reuse the same identity hasher.
    CustomerIdentityHasher,
    PaidGiftEligibilityService,
    // P64 C5 — exported so the sequence evaluator can be driven directly
    // by a fake-clock regression suite, exactly as `SubscriptionExpiryService`
    // already is.
    TenantLifecycleService,
    // Exported so `BillingModule` (renewal arithmetic) and
    // `ProvisioningModule` (the effective-status gate) share the SAME
    // clock as every access decision — one instant per module graph.
    PLANS_CLOCK,
  ],
})
export class PlansModule {}
