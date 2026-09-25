/**
 * RetentionModule — P64 Communications C6 (plan §31/§32), hosted-video
 * retention: the W1-W4 warning sequence and the deletion that follows it.
 *
 * A MODULE OF ITS OWN, rather than more surface on `PlansModule`, for a
 * structural reason: this work needs BOTH the subscription clock (which
 * `PlansModule` owns) and the video adapters (which `MediaModule` owns),
 * and `MediaModule` already imports `PlansModule`. Putting it in
 * `PlansModule` would mean `PlansModule` importing `MediaModule` and a
 * cycle; putting it in `MediaModule` would bury a destructive tenant
 * lifecycle behind a media library. A leaf module that imports both is the
 * only arrangement with no cycle — and, usefully, it means everything that
 * can delete a customer's video lives in one directory.
 *
 * It also owns its own queue and its own repeatable tick rather than
 * riding the `subscription-sweep` job, for the same reason: the sweep
 * lives in `PlansModule` and cannot call into this one. One queue, ONE
 * processor, three job names — see `video-retention.types.ts`.
 *
 * Nothing imports this module. It is a leaf, and deliberately so.
 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TenancyModule } from '../tenancy/tenancy.module';
import { IdentityModule } from '../identity/identity.module';
import { PlansModule } from '../plans/plans.module';
import { MediaModule } from '../media/media.module';
import { VideoRetentionRepository } from './repositories/video-retention.repository';
import { VideoRetentionService } from './services/video-retention.service';
import { VideoRetentionDeletionService } from './services/video-retention-deletion.service';
import { VideoRetentionProducer } from './queue/video-retention.producer';
import { VideoRetentionProcessor } from './queue/video-retention.processor';
import { VideoRetentionScheduler } from './queue/video-retention.scheduler';
import { VIDEO_RETENTION_QUEUE } from './queue/video-retention.types';

@Module({
  imports: [
    // `TenancyContextService` — every read and write in this module runs
    // under a real RLS context, never `runWithoutContext`.
    TenancyModule,
    // `UsersRepository`, to resolve the platform-owner id the sweep and
    // the deletion jobs run as.
    IdentityModule,
    // `PLANS_CLOCK` (one instant per module graph, and pinnable by the
    // regression suite) and `TenantUsageRecomputeProducer`.
    PlansModule,
    // `VideoProviderRegistry` (the adapter that owns an asset's bytes) and
    // `ProtectedMediaStorage` (the absence probe for the R2 tier).
    MediaModule,
    BullModule.registerQueue({ name: VIDEO_RETENTION_QUEUE }),
  ],
  providers: [
    VideoRetentionRepository,
    VideoRetentionService,
    VideoRetentionDeletionService,
    VideoRetentionProducer,
    VideoRetentionProcessor,
    VideoRetentionScheduler,
  ],
  exports: [
    // Exported so a fake-clock regression suite can drive the sweep and
    // the deletion directly, exactly as `TenantLifecycleService` is.
    VideoRetentionService,
    VideoRetentionDeletionService,
  ],
})
export class RetentionModule {}
