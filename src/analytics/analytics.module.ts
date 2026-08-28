/**
 * AnalyticsModule — Phase P16 (master plan §21): Platform Analytics.
 * Wires `GET /platform-metrics` (the Platform Command Center singleton)
 * and `GET /analytics/{overview,time-series/:metric,breakdown/:dimension}`
 * (the date-ranged Analytics tab) — both Platform-Owner-gated,
 * cross-tenant, read-only.
 *
 * Deliberately a self-contained, DOWNSTREAM leaf module: its repositories
 * query `organizations`/`academies`/`courses`/`tenant_subscriptions`/
 * `tenant_usage`/`payments`/`revenue_ledger_entries`/`users`/`plans`
 * directly via `PrismaService`, reusing RLS policies already shipped by
 * P12/P13/P15 (`_platform_select`/`payments_platform_review_select`) —
 * NO new RLS policy this phase, confirmed by direct inspection of every
 * existing migration before writing any query here (both `payments` and
 * `revenue_ledger_entries` already grant an unconditional
 * `is_platform_owner()`-gated SELECT; see git history for the discovered,
 * reverted duplicate-policy migration attempt). Only `TenancyModule`
 * (`TenancyContextService`, to open the RLS session context) and
 * `IdentityModule` (`PlatformOwnerGuard`)/`AuthCoreModule`
 * (`JwtAuthGuard`) are imported — no coupling to `AcademyModule`/
 * `CourseModule`/`PlansModule`/`BillingModule`'s own repositories, since
 * none of their list/find-shaped methods fit this phase's aggregate-query
 * needs.
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { PlatformMetricsController } from './controllers/platform-metrics.controller';
import { AnalyticsController } from './controllers/analytics.controller';
import { PlatformMetricsService } from './services/platform-metrics.service';
import { AnalyticsService } from './services/analytics.service';
import { PlatformScaleRepository } from './repositories/platform-scale.repository';
import { AnalyticsRevenueRepository } from './repositories/analytics-revenue.repository';

@Module({
  imports: [AuthCoreModule, IdentityModule, TenancyModule],
  controllers: [PlatformMetricsController, AnalyticsController],
  providers: [
    PlatformMetricsService,
    AnalyticsService,
    PlatformScaleRepository,
    AnalyticsRevenueRepository,
  ],
})
export class AnalyticsModule {}
