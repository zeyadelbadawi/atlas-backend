/**
 * DashboardModule — Phase 8 (Support, Audit & Dashboards). Wires the one
 * tenant-scoped aggregation endpoint the dashboard reads.
 *
 * Its own module rather than an addition to an existing one, for the same
 * reason `ProvisioningModule` is: it genuinely needs providers from
 * several prior phases at once — `AcademyModule` (`AcademiesRepository`
 * and `AcademyScopeGuard`), `TenancyModule` (`TenancyContextService`,
 * `OrganizationMembershipGuard`), `PlansModule`
 * (`TenantSubscriptionService`, reused verbatim so effective entitlements
 * are still computed in exactly one place), and `BillingModule`
 * (`OrganizationPaymentSettingsRepository`, the real source of the
 * payment-collection mode the revenue widget's honesty depends on) — and
 * having any one of those import the others to reach the rest would
 * create a module-DAG cycle.
 *
 * A clean DAG: every module imported here is upstream of this one and
 * none of them import `DashboardModule`. `AuditLogModule` is not imported
 * — the activity read goes through this module's own
 * `DashboardMetricsRepository` (`audit_log_entries` is read here under
 * tenant context, a different access shape from `AuditLogEntriesRepository`'s
 * Platform-Owner-scoped reads), and `AuditLogWriterService` is `@Global()`
 * anyway.
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AcademyModule } from '../academy/academy.module';
import { PlansModule } from '../plans/plans.module';
import { BillingModule } from '../billing/billing.module';
import { DashboardController } from './controllers/dashboard.controller';
import { DashboardService } from './services/dashboard.service';
import { DashboardMetricsRepository } from './repositories/dashboard-metrics.repository';
// Phase 9 — the Client Owner's student progress rollup (roadmap CO11).
import { StudentAnalyticsController } from './controllers/student-analytics.controller';
import { StudentAnalyticsService } from './services/student-analytics.service';
import { StudentAnalyticsRepository } from './repositories/student-analytics.repository';

@Module({
  imports: [AuthCoreModule, TenancyModule, AcademyModule, PlansModule, BillingModule],
  controllers: [DashboardController, StudentAnalyticsController],
  providers: [
    DashboardService,
    DashboardMetricsRepository,
    StudentAnalyticsService,
    StudentAnalyticsRepository,
  ],
})
export class DashboardModule {}
