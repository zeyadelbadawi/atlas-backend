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
import { BullModule } from '@nestjs/bullmq';
import { AuthCoreModule } from '../identity/auth-core.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AcademyModule } from '../academy/academy.module';
// `UsersRepository` — resolving a platform-owner id for the one
// deliberately cross-tenant, system-initiated read (webhook attribution).
import { IdentityModule } from '../identity/identity.module';
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
import { LiveProviderConnectionController } from './controllers/live-provider-connection.controller';
import { LiveProviderWebhookController } from './controllers/live-provider-webhook.controller';
import { StudentLiveSessionsController } from './controllers/student-live-sessions.controller';
import { LiveProviderConnectionService } from './services/live-provider-connection.service';
import { LiveProviderOAuthController } from './controllers/live-provider-oauth.controller';
import { ZoomOAuthService } from './services/zoom-oauth.service';
import { RecordingImportService } from './services/recording-import.service';
import { LiveSessionNotificationsService } from './services/live-session-notifications.service';
import { LiveProviderEventsRepository } from './repositories/live-provider-events.repository';
import { LiveProviderEventProducer } from './queue/live-provider-event.producer';
import { LiveProviderEventProcessor } from './queue/live-provider-event.processor';
import { LIVE_PROVIDER_EVENT_QUEUE } from './queue/live-provider-event.types';
import { LiveSessionProvisioningService } from './services/live-session-provisioning.service';
import { LiveSessionSweepService } from './services/live-session-sweep.service';
import { LiveSessionSweepProcessor } from './queue/live-session-sweep.processor';
import { LiveSessionSweepScheduler } from './queue/live-session-sweep.scheduler';
import { LIVE_SESSION_SWEEP_QUEUE } from './queue/live-session-sweep.types';
import { MediaModule } from '../media/media.module';
import { NotificationEventsModule } from '../notification-events/notification-events.module';

@Module({
  imports: [
    AuthCoreModule,
    TenancyModule,
    AcademyModule,
    IdentityModule,
    PlansModule,
    AuditLogModule,
    BillingModule,
    // Recording import goes through the EXISTING media pipeline, never a
    // second storage path.
    MediaModule,
    // Notifications reuse the existing fan-out, never a second delivery
    // system.
    NotificationEventsModule,
    // Provider events are processed off the request thread, mirroring
    // `payment-webhook`.
    BullModule.registerQueue({ name: LIVE_PROVIDER_EVENT_QUEUE }),
    // Starting-soon reminders and attendance reconciliation, on the ONE
    // recurring-job mechanism this codebase already uses.
    BullModule.registerQueue({ name: LIVE_SESSION_SWEEP_QUEUE }),
  ],
  controllers: [
    LiveSessionsController,
    AddOnsLifecycleController,
    LiveProviderConnectionController,
    LiveProviderOAuthController,
    LiveProviderWebhookController,
    StudentLiveSessionsController,
  ],
  providers: [
    LiveSessionService,
    AttendanceService,
    AddOnAccessService,
    RecordingQuotaService,
    LiveSessionAccessService,
    ZoomProvider,
    LiveProviderConnectionService,
    ZoomOAuthService,
    RecordingImportService,
    LiveSessionNotificationsService,
    LiveProviderEventsRepository,
    LiveProviderEventProducer,
    LiveProviderEventProcessor,
    LiveSessionProvisioningService,
    LiveSessionSweepService,
    LiveSessionSweepProcessor,
    LiveSessionSweepScheduler,
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
