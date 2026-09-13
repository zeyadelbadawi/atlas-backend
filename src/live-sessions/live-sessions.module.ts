/**
 * LiveSessionsModule — Phase 12, the Live Sessions add-on.
 *
 * REUSES RATHER THAN REBUILDS. Everything this feature needs already
 * existed somewhere in Atlas, and this module imports it instead of
 * growing a parallel copy:
 *
 *   PlansModule    — `EntitlementService` and the subscription/add-on
 *                    repositories. The add-on grants its capability
 *                    through the EXISTING `AddOnFeatureEffect` mechanism,
 *                    and the recording allowance is an ordinary
 *                    `PlanLimitKey`. No second entitlement model.
 *   AcademyModule  — `AcademyScopeGuard` (verbatim, unmodified) and
 *                    `AcademyMembersRepository` for the managing-role gate
 *                    that `CoursesService` already defines.
 *   TenancyModule  — `TenancyContextService`, so every read and write runs
 *                    inside the same RLS tenant context as the rest of the
 *                    platform.
 *   AuditLogModule — the existing audit writer. Session lifecycle events
 *                    land in the same log as everything else.
 *   BillingModule  — `CredentialEncryptionService`, the ONE AES-256-GCM
 *                    seam this codebase has. Zoom credentials are stored
 *                    with the same mechanism as payment gateway
 *                    credentials rather than a second secret store.
 *
 * `ZoomProvider` is registered as a plain provider rather than behind a
 * registry: there is exactly one live provider today, and inventing a
 * lookup layer for a single implementation would be abstraction without a
 * second case to justify it. The `LiveProviderAdapter` interface is the
 * seam that makes adding one cheap when it happens.
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AcademyModule } from '../academy/academy.module';
import { PlansModule } from '../plans/plans.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { BillingModule } from '../billing/billing.module';
import { LiveSessionsController } from './controllers/live-sessions.controller';
import { AddOnsLifecycleController } from './controllers/add-ons-lifecycle.controller';
import { LiveSessionService } from './services/live-session.service';
import { AttendanceService } from './services/attendance.service';
import { AddOnAccessService } from './services/add-on-access.service';
import { RecordingQuotaService } from './services/recording-quota.service';
import { LiveSessionAccessService } from './services/live-session-access.service';
import { ZoomProvider } from './providers/zoom.provider';

@Module({
  imports: [
    AuthCoreModule,
    TenancyModule,
    AcademyModule,
    PlansModule,
    AuditLogModule,
    BillingModule,
  ],
  controllers: [LiveSessionsController, AddOnsLifecycleController],
  providers: [
    LiveSessionService,
    AttendanceService,
    AddOnAccessService,
    RecordingQuotaService,
    LiveSessionAccessService,
    ZoomProvider,
  ],
  exports: [
    // Exported so the learning surface can ask "may this student join?"
    // without duplicating the eligibility rules.
    LiveSessionAccessService,
    AddOnAccessService,
    RecordingQuotaService,
  ],
})
export class LiveSessionsModule {}
