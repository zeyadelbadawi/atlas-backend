/**
 * CourseCommerceModule — Phase P13 (master plan §21/§23). Wires the real
 * Course Commerce money flow: paid-course purchase (`course_orders`),
 * payment creation/review through the SAME `PaymentProviderAdapter`/
 * `PaymentProviderRegistry`/`payment_methods` catalog P12 already
 * established, Atlas commission resolution/snapshotting (§4.2, extended
 * to three tiers this session), full-refund-within-30-days (this
 * session's product direction), and Academy payout computation/recording
 * (§5.8).
 *
 * Deliberately its OWN module, not an extension of `BillingModule` or
 * `LearningModule` — this money flow genuinely needs providers from BOTH
 * (`PaymentsRepository`/`PaymentProviderRegistry`/`CommissionService` from
 * billing; `EnrollmentsService`/`EnrollmentsRepository` from learning), and
 * `BillingModule` importing `LearningModule` (or vice versa) to reach into
 * the other would create exactly the kind of module-DAG cycle this
 * codebase's every prior phase module comment explicitly avoids
 * ("DAG-cleanliness reasoning," `CourseModule`/`PlansModule`/
 * `LearningModule`'s own doc comments). A new phase module that imports
 * both — reusing every provider each already exports, inventing none of
 * their logic a second time — is the SAME pattern every prior phase
 * already used to add new capability without disturbing an earlier
 * phase's module, applied here rather than a novel one.
 *
 * `PaymentApplicationService` (P12) itself is left completely unmodified
 * — `CourseOrderPaymentApplicationService` is the Course Commerce
 * equivalent, not a branch inside that class, for the identical
 * DAG-cleanliness reason above. Both classes independently satisfy master
 * plan §10's "ONE place a Payment's success is applied" rule, one per
 * money flow — matching ADR-010's own "two distinct money flows sharing
 * one provider-agnostic adapter and one extended `payments` table" design
 * exactly: shared TABLE and PROVIDER ABSTRACTION, never a shared or
 * duplicated APPLICATION-service.
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { CourseModule } from '../course/course.module';
import { AcademyModule } from '../academy/academy.module';
import { LearningModule } from '../learning/learning.module';
import { BillingModule } from '../billing/billing.module';
import { PlansModule } from '../plans/plans.module';
import { CourseOrdersController } from './controllers/course-orders.controller';
import { CourseOrderPaymentsController } from './controllers/course-order-payments.controller';
import { CourseOrderRefundsController } from './controllers/course-order-refunds.controller';
import { PlatformCourseOrderPaymentsController } from './controllers/platform-course-order-payments.controller';
import { AcademyPayoutsController } from './controllers/academy-payouts.controller';
import { PlatformAcademyPayoutsController } from './controllers/platform-academy-payouts.controller';
import { CourseOrdersService } from './services/course-orders.service';
import { CourseOrderPaymentsService } from './services/course-order-payments.service';
import { CourseOrderPaymentApplicationService } from './services/course-order-payment-application.service';
import { PlatformCourseOrderPaymentsService } from './services/platform-course-order-payments.service';
import { CourseOrderRefundsService } from './services/course-order-refunds.service';
import { AcademyPayoutsService } from './services/academy-payouts.service';
import { PlatformAcademyPayoutsService } from './services/platform-academy-payouts.service';
import { CourseOrdersRepository } from './repositories/course-orders.repository';
import { RevenueLedgerEntriesRepository } from './repositories/revenue-ledger-entries.repository';
import {
  AcademyPayoutItemsRepository,
  AcademyPayoutsRepository,
} from './repositories/academy-payouts.repository';
import { CourseOrderRefundsRepository } from './repositories/course-order-refunds.repository';

@Module({
  imports: [
    AuthCoreModule,
    IdentityModule,
    TenancyModule,
    CourseModule,
    AcademyModule,
    LearningModule,
    BillingModule,
    // Phase 2 — `CourseOrderPaymentApplicationService` needs
    // `TenantUsageRecomputeProducer` to keep the `students` usage metric
    // current after a paid-course enrollment (a real enrollment change,
    // same as the free path) — never `EntitlementEnforcementService`
    // here; see that service's own doc comment for why a successful
    // payment's enrollment is never blocked by a plan limit.
    PlansModule,
  ],
  controllers: [
    CourseOrdersController,
    CourseOrderPaymentsController,
    CourseOrderRefundsController,
    PlatformCourseOrderPaymentsController,
    AcademyPayoutsController,
    PlatformAcademyPayoutsController,
  ],
  providers: [
    CourseOrdersService,
    CourseOrderPaymentsService,
    CourseOrderPaymentApplicationService,
    PlatformCourseOrderPaymentsService,
    CourseOrderRefundsService,
    AcademyPayoutsService,
    PlatformAcademyPayoutsService,
    CourseOrdersRepository,
    RevenueLedgerEntriesRepository,
    AcademyPayoutsRepository,
    AcademyPayoutItemsRepository,
    CourseOrderRefundsRepository,
  ],
})
export class CourseCommerceModule {}
