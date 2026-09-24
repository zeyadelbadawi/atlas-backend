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
 * Binds the suppression lookup to a no-op; the provider registry replaces
 * that binding when it ships.
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
import { CommunicationBrandingService } from './services/communication-branding.service';
import { CommunicationPreferencesService } from './services/communication-preferences.service';
import { EmailTransport } from './services/email-transport';
import { LinkBuilderService } from './services/link-builder.service';
import {
  COMMUNICATION_SUPPRESSION,
  NoopCommunicationSuppression,
} from './services/communication-suppression.interface';
import { CommunicationMetricsService } from './metrics/communication-metrics.service';
import { CommunicationPreferencesController } from './controllers/communication-preferences.controller';

@Global()
@Module({
  imports: [
    AuthCoreModule,
    IdentityModule,
    TenancyModule,
    BullModule.registerQueue({ name: COMMUNICATIONS_QUEUE }),
  ],
  controllers: [CommunicationPreferencesController],
  providers: [
    CommunicationMetricsService,
    EmailTransport,
    LinkBuilderService,
    CommunicationBrandingService,
    { provide: COMMUNICATION_SUPPRESSION, useClass: NoopCommunicationSuppression },
    CommunicationsProducer,
    CommunicationService,
    CommunicationDispatchService,
    CommunicationPreferencesService,
    CommunicationsProcessor,
    CommunicationsScheduler,
  ],
  exports: [
    CommunicationService,
    CommunicationDispatchService,
    CommunicationPreferencesService,
    CommunicationMetricsService,
    LinkBuilderService,
    EmailTransport,
    COMMUNICATION_SUPPRESSION,
  ],
})
export class CommunicationsModule {}
