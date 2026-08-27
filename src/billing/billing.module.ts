/**
 * BillingModule — Phase P12 (master plan §21). Wires Atlas Subscription
 * Billing: the payment-methods catalog (platform-owned, no RLS),
 * Checkout/Payment (organization-scoped, RLS-protected), Platform Payment
 * review (flat, cross-tenant, `PlatformOwnerGuard`-gated), the private
 * payment-proof object store, and the payment-webhook queue/worker.
 *
 * Imports `AuthCoreModule` (`JwtAuthGuard`), `IdentityModule`
 * (`PlatformOwnerGuard`, reused verbatim — same DAG-cleanliness reasoning
 * `PlansModule` already documents), `TenancyModule`
 * (`TenancyContextService`/`OrganizationMembershipGuard`/
 * `OrganizationMembershipsRepository`), and `PlansModule` (the catalog +
 * write-repository exports P12 added to it — see that module's own doc
 * comment).
 *
 * Also wires the Organization Payment Configuration foundation (master
 * plan §4.1/§4.2/§5.8, prerequisite to Phase P13): the payment-provider
 * abstraction (`PaymentProviderRegistry`/`ManualTransferProvider`, ADR-010
 * 2026-08-26 update), an Organization's payment-collection-mode/own-gateway
 * credentials/Atlas-Payments-connected-account settings, and commission
 * configuration (global default + Organization override, Platform-Owner
 * write-gated). No Course Commerce table/service is wired here — that
 * remains Phase P13.
 *
 * Also wires Atlas Subscription Payment — Generic Payment Gateway
 * Integration Readiness (2026-08-26): the Platform-Owner-only
 * configuration of which registered `PaymentProviderAdapter` currently
 * backs Atlas's own Subscription Billing (distinct from both P12's
 * `payment_methods` catalog and §5.8's Organization-owned tables above).
 *
 * Phase P13 addition: `PlanCommissionSettingsRepository` (the plan-tier
 * level of §4.2's now-three-tier commission hierarchy, wired into the
 * existing `CommissionService`/`PlatformCommissionController` rather than
 * a parallel service). `CourseCommerceModule` (the real Course Commerce
 * money flow — `course_orders`/`revenue_ledger_entries`/payouts/refunds)
 * imports THIS module to reuse `PaymentsRepository`/
 * `PaymentAttemptsRepository`/`PaymentProofsRepository`/
 * `PaymentProofStorageService`/`PaymentProviderRegistry`/
 * `CommissionService`/`OrganizationPaymentSettingsRepository`/
 * `OrganizationMembershipsRepository` (the latter via `TenancyModule`) —
 * see this `exports` array below and `CourseCommerceModule`'s own doc
 * comment for the full "reuse, never duplicate" reasoning (ADR-010, this
 * phase's explicit instruction).
 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { PlansModule } from '../plans/plans.module';
import { CheckoutController } from './controllers/checkout.controller';
import { PaymentMethodsController } from './controllers/payment-methods.controller';
import { PaymentController } from './controllers/payment.controller';
import { PlatformPaymentController } from './controllers/platform-payment.controller';
import { PaymentWebhookController } from './controllers/payment-webhook.controller';
import { OrganizationPaymentSettingsController } from './controllers/organization-payment-settings.controller';
import { PlatformCommissionController } from './controllers/platform-commission.controller';
import { PlatformAtlasPaymentProviderController } from './controllers/platform-atlas-payment-provider.controller';
import { CheckoutService } from './services/checkout.service';
import { PaymentService } from './services/payment.service';
import { PlatformPaymentService } from './services/platform-payment.service';
import { PaymentApplicationService } from './services/payment-application.service';
import { PaymentWebhookService } from './services/payment-webhook.service';
import { OrganizationPaymentSettingsService } from './services/organization-payment-settings.service';
import { OrganizationGatewayCredentialsService } from './services/organization-gateway-credentials.service';
import { OrganizationConnectedAccountService } from './services/organization-connected-account.service';
import { CommissionService } from './services/commission.service';
import { AtlasSubscriptionPaymentProviderService } from './services/atlas-subscription-payment-provider.service';
import { PaymentMethodsRepository } from './repositories/payment-methods.repository';
import { CheckoutsRepository } from './repositories/checkouts.repository';
import { PaymentsRepository } from './repositories/payments.repository';
import { PaymentAttemptsRepository } from './repositories/payment-attempts.repository';
import { PaymentProofsRepository } from './repositories/payment-proofs.repository';
import { PaymentReviewsRepository } from './repositories/payment-reviews.repository';
import { TenantInvoicesRepository } from './repositories/tenant-invoices.repository';
import { PaymentWebhookEventsRepository } from './repositories/payment-webhook-events.repository';
import { OrganizationPaymentSettingsRepository } from './repositories/organization-payment-settings.repository';
import { OrganizationGatewayCredentialsRepository } from './repositories/organization-gateway-credentials.repository';
import { OrganizationConnectedAccountsRepository } from './repositories/organization-connected-accounts.repository';
import { OrganizationCommissionSettingsRepository } from './repositories/organization-commission-settings.repository';
import { AtlasCommissionConfigRepository } from './repositories/atlas-commission-config.repository';
import { PlanCommissionSettingsRepository } from './repositories/plan-commission-settings.repository';
import { AtlasSubscriptionPaymentProviderConfigRepository } from './repositories/atlas-subscription-payment-provider-config.repository';
import { PaymentProofStorageService } from './storage/payment-proof-storage.service';
import { CredentialEncryptionService } from './utils/credential-encryption.util';
import { PaymentProviderRegistry } from './providers/payment-provider.registry';
import { ManualTransferProvider } from './providers/manual-transfer.provider';
import { PaymentWebhookProducer } from './queue/payment-webhook.producer';
import { PaymentWebhookProcessor } from './queue/payment-webhook.processor';
import { PAYMENT_WEBHOOK_QUEUE } from './queue/payment-webhook.types';

@Module({
  imports: [
    AuthCoreModule,
    IdentityModule,
    TenancyModule,
    PlansModule,
    BullModule.registerQueue({ name: PAYMENT_WEBHOOK_QUEUE }),
  ],
  controllers: [
    CheckoutController,
    PaymentMethodsController,
    PaymentController,
    PlatformPaymentController,
    PaymentWebhookController,
    OrganizationPaymentSettingsController,
    PlatformCommissionController,
    PlatformAtlasPaymentProviderController,
  ],
  providers: [
    CheckoutService,
    PaymentService,
    PlatformPaymentService,
    PaymentApplicationService,
    PaymentWebhookService,
    OrganizationPaymentSettingsService,
    OrganizationGatewayCredentialsService,
    OrganizationConnectedAccountService,
    CommissionService,
    AtlasSubscriptionPaymentProviderService,
    PaymentMethodsRepository,
    CheckoutsRepository,
    PaymentsRepository,
    PaymentAttemptsRepository,
    PaymentProofsRepository,
    PaymentReviewsRepository,
    TenantInvoicesRepository,
    PaymentWebhookEventsRepository,
    OrganizationPaymentSettingsRepository,
    OrganizationGatewayCredentialsRepository,
    OrganizationConnectedAccountsRepository,
    OrganizationCommissionSettingsRepository,
    AtlasCommissionConfigRepository,
    PlanCommissionSettingsRepository,
    AtlasSubscriptionPaymentProviderConfigRepository,
    PaymentProofStorageService,
    CredentialEncryptionService,
    ManualTransferProvider,
    PaymentProviderRegistry,
    PaymentWebhookProducer,
    PaymentWebhookProcessor,
  ],
  exports: [
    // Phase P13 — the exact, narrow set `CourseCommerceModule` needs to
    // reuse the P12/P12.5 payment infrastructure without duplicating any
    // of it. Nothing else in this module is exported — every other
    // provider stays this module's own internal implementation detail,
    // matching `PlansModule`'s identical "export only what a later phase
    // genuinely needs" precedent.
    PaymentsRepository,
    PaymentAttemptsRepository,
    PaymentProofsRepository,
    PaymentReviewsRepository,
    PaymentMethodsRepository,
    PaymentProofStorageService,
    PaymentProviderRegistry,
    CommissionService,
    OrganizationPaymentSettingsService,
    OrganizationPaymentSettingsRepository,
    OrganizationGatewayCredentialsRepository,
  ],
})
export class BillingModule {}
