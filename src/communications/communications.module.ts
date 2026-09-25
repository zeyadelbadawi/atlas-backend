/**
 * CommunicationsModule — P64 Communications C1–C3.
 *
 * `@Global()`, mirroring `NotificationEventsModule`/`AuditLogModule`: a
 * leaf module every emitting module (billing, course-commerce,
 * provisioning, platform, identity, certificates, instructor,
 * live-sessions) injects `CommunicationService` from without an explicit
 * `imports` entry — the alternative (each of them importing this module,
 * which imports `IdentityModule`, which several of them are imported BY)
 * is a module cycle Nest refuses to construct.
 *
 * Owns the `communications` queue (dispatch/sweep/digest/prune), the
 * catalogue, templates, link builder, preferences endpoint and metrics.
 *
 * `COMMUNICATION_SUPPRESSION` is bound to the REAL `SuppressionService`
 * (reachable because `IdentityModule`, imported below, re-exports
 * `CommunicationsProvidersModule`). The dispatcher therefore checks the
 * hashed suppression list — fed by the providers' delivery webhooks —
 * before every send, so an address that hard-bounced or filed a spam
 * complaint is never mailed again, whatever the catalogue says. The
 * no-op in `communication-suppression.interface.ts` stays as the port's
 * default for unit tests that construct the dispatcher directly; binding
 * it HERE would silently mail suppressed addresses in production.
 */
import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { COMMUNICATIONS_QUEUE } from './queue/communications.types';
import { CommunicationsProducer } from './queue/communications.producer';
import { CommunicationsProcessor } from './queue/communications.processor';
import { CommunicationsScheduler } from './queue/communications.scheduler';
import { CommunicationService } from './services/communication.service';
import { CommunicationDispatchService } from './services/communication-dispatch.service';
import { QuizExceptionActivationService } from './services/quiz-exception-activation.service';
import { CommunicationBrandingService } from './services/communication-branding.service';
import { CommunicationPreferencesService } from './services/communication-preferences.service';
import { EmailTransport } from './services/email-transport';
import { LinkBuilderService } from './services/link-builder.service';
import { AcademyStaffRecipientsService } from './services/academy-staff-recipients.service';
import { COMMUNICATION_SUPPRESSION } from './services/communication-suppression.interface';
import { SuppressionService } from './services/suppression.service';
import { CommunicationMetricsService } from './metrics/communication-metrics.service';
import { PLANS_CLOCK, SystemClock } from '../plans/utils/clock';
import { CommunicationPreferencesController } from './controllers/communication-preferences.controller';
import { PlatformCommunicationsController } from './controllers/platform-communications.controller';
import { PlatformCommunicationsHealthService } from './services/platform-communications-health.service';
import { CommunicationSettingsViewService } from './services/communication-settings-view.service';

@Global()
@Module({
  imports: [
    AuthCoreModule,
    IdentityModule,
    TenancyModule,
    BullModule.registerQueue({ name: COMMUNICATIONS_QUEUE }),
  ],
  controllers: [CommunicationPreferencesController, PlatformCommunicationsController],
  providers: [
    CommunicationSettingsViewService,
    CommunicationMetricsService,
    PlatformCommunicationsHealthService,
    EmailTransport,
    LinkBuilderService,
    AcademyStaffRecipientsService,
    CommunicationBrandingService,
    { provide: COMMUNICATION_SUPPRESSION, useExisting: SuppressionService },
    CommunicationsProducer,
    CommunicationService,
    CommunicationDispatchService,
    CommunicationPreferencesService,
    /*
      W-EXC — the scheduled-exception sweep needs a pinnable instant.

      `PLANS_CLOCK` is BOUND here rather than imported from `PlansModule`,
      and that is deliberate: `PlansModule`'s own header records that it
      reaches `CommunicationService` through this `@Global()` module
      precisely so that no import edge exists between the two. Adding
      `PlansModule` to `imports` above would close that loop and Nest
      would refuse to build the graph. The token is shared so that one
      `overrideProvider(PLANS_CLOCK)` in a regression suite pins every
      clock in the process, exactly as the lifecycle suites already
      assume; `SystemClock` is stateless, so a second instance of it
      changes nothing in production.
    */
    { provide: PLANS_CLOCK, useClass: SystemClock },
    QuizExceptionActivationService,
    CommunicationsProcessor,
    CommunicationsScheduler,
  ],
  exports: [
    CommunicationService,
    // Cloud remediation (finding G) — read by PlatformModule and AcademyModule.
    CommunicationSettingsViewService,
    CommunicationDispatchService,
    // Exported so the activation sweep can be driven directly by a
    // fake-clock regression suite, exactly as `TenantLifecycleService` is.
    QuizExceptionActivationService,
    CommunicationPreferencesService,
    CommunicationMetricsService,
    LinkBuilderService,
    AcademyStaffRecipientsService,
    EmailTransport,
    COMMUNICATION_SUPPRESSION,
  ],
})
export class CommunicationsModule {}
