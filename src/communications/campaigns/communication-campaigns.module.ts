/**
 * W3-compose — person-authored messages: the Platform Owner's "Compose and
 * send" and an academy's "Messages", on one campaign model.
 *
 * Its own module and its own `communication-campaigns` queue with ONE
 * processor (never a second worker on `communications`). It reaches
 * `CommunicationsProducer`, `CommunicationPreferencesService` and
 * `LinkBuilderService` through the `@Global()` `CommunicationsModule`, the
 * entitlement readers through `PlansModule`, and `AcademyScopeGuard`
 * through `AcademyModule` — none of which imports this module, so the
 * graph stays a DAG.
 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthCoreModule } from '../../identity/auth-core.module';
import { IdentityModule } from '../../identity/identity.module';
import { TenancyModule } from '../../tenancy/tenancy.module';
import { PlansModule } from '../../plans/plans.module';
import { AcademyModule } from '../../academy/academy.module';
import { CAMPAIGNS_QUEUE } from './queue/campaigns.types';
import { CampaignsProducer } from './queue/campaigns.producer';
import { CampaignsProcessor } from './queue/campaigns.processor';
import { CampaignsScheduler } from './queue/campaigns.scheduler';
import { CommunicationCampaignService } from './communication-campaign.service';
import { CampaignWorkerService } from './campaign-worker.service';
import { AcademyEmailQuotaService } from './academy-email-quota.service';
import { PlatformCampaignsController } from './controllers/platform-campaigns.controller';
import { AcademyMessagesController } from './controllers/academy-messages.controller';
import { UnsubscribeController } from './controllers/unsubscribe.controller';

@Module({
  imports: [
    AuthCoreModule,
    IdentityModule,
    TenancyModule,
    PlansModule,
    AcademyModule,
    BullModule.registerQueue({ name: CAMPAIGNS_QUEUE }),
  ],
  controllers: [
    PlatformCampaignsController,
    AcademyMessagesController,
    UnsubscribeController,
  ],
  providers: [
    CampaignsProducer,
    CampaignsProcessor,
    CampaignsScheduler,
    AcademyEmailQuotaService,
    CommunicationCampaignService,
    CampaignWorkerService,
  ],
  exports: [
    CommunicationCampaignService,
    CampaignWorkerService,
    AcademyEmailQuotaService,
  ],
})
export class CommunicationCampaignsModule {}
