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
import { AuthCoreModule } from '../identity/auth-core.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { IdentityModule } from '../identity/identity.module';
import { PlansModule } from '../plans/plans.module';
import { MediaModule } from '../media/media.module';
import { VideoRetentionRepository } from './repositories/video-retention.repository';
import { TenantRetentionViewRepository } from './repositories/tenant-retention-view.repository';
import { VideoRetentionService } from './services/video-retention.service';
import { TenantRetentionViewService } from './services/tenant-retention-view.service';
import { TenantRetentionController } from './controllers/tenant-retention.controller';
import { ArchivedMediaPurgeService } from './services/archived-media-purge.service';
import { VideoRetentionDeletionService } from './services/video-retention-deletion.service';
import { VideoRetentionProducer } from './queue/video-retention.producer';
import { VideoRetentionProcessor } from './queue/video-retention.processor';
import { VideoRetentionScheduler } from './queue/video-retention.scheduler';
import { VIDEO_RETENTION_QUEUE } from './queue/video-retention.types';

@Module({
  imports: [
    /*
      `JwtAuthGuard` and the `AccessTokenService` behind it, for the
      customer-facing controller below. Imported DIRECTLY rather than
      relied on transitively: `PlansModule` imports `AuthCoreModule` but
      does not re-export it, and Nest resolves providers per module
      graph — a guard that cannot be constructed fails the whole
      application at boot, not at request time. No cycle:
      `AuthCoreModule` depends on neither this module nor `PlansModule`.
    */
    AuthCoreModule,
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
  controllers: [
    /*
      P64 C6 customer surface — `GET /organizations/:id/retention`, the
      read behind `/dashboard/tenant/retention`. The warning emails have
      always linked there; until this controller existed the link had no
      destination. Read-only: it adds a window onto the sweep's own
      decisions and changes none of them.
    */
    TenantRetentionController,
  ],
  providers: [
    VideoRetentionRepository,
    TenantRetentionViewRepository,
    TenantRetentionViewService,
    VideoRetentionService,
    VideoRetentionDeletionService,
    ArchivedMediaPurgeService,
    VideoRetentionProducer,
    VideoRetentionProcessor,
    VideoRetentionScheduler,
  ],
  exports: [
    // Exported so a fake-clock regression suite can drive the sweep and
    // the deletion directly, exactly as `TenantLifecycleService` is.
    VideoRetentionService,
    VideoRetentionDeletionService,
    ArchivedMediaPurgeService,
    // Exported so the e2e suite can assert the owner-facing payload
    // directly as well as over HTTP.
    TenantRetentionViewService,
  ],
})
export class RetentionModule {}
