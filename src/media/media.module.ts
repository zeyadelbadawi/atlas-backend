/**
 * MediaModule — Phase P8 (master plan §21). Wires the Media Library
 * surface: `MediaController`/Service/Repository, the R2 storage provider,
 * and the `media-processing` worker.
 *
 * Imports `AuthCoreModule` (`JwtAuthGuard`), `TenancyModule`
 * (`TenancyContextService`), and `AcademyModule` (`AcademyScopeGuard`/
 * `AcademyMembersRepository`, both reused verbatim, unmodified — the same
 * "reuse the existing tenancy backbone, never duplicate it" rule
 * `CourseModule` already established). No new guard, no new session
 * variable, no new tenant mechanism.
 *
 * `MEDIA_STORAGE_PROVIDER` is bound to `R2StorageProvider` — the ONE real
 * implementation, used in every environment (production talks real
 * Cloudflare R2; development/test talk a local MinIO container,
 * docker-compose.yml — see `R2StorageProvider`'s own doc comment for why
 * this is not a fake/stub). A DI token, not a direct class reference, so
 * a future environment-specific swap (if ever needed) is a one-line
 * provider change, never a call-site rewrite.
 *
 * Thumbnail design note (master plan's own "do not invent a new public
 * response shape" instruction): `media-worker` extracts real
 * `width`/`height` only — no thumbnail *file* is generated, because the
 * real frontend contract (`MediaAssetSummary`) has no thumbnail-url field
 * for one to ever be returned through. Generating one would be dead
 * storage with no response shape to reach it.
 *
 * Imports `PlansModule` as of Phase 2 — `MediaService.upload` needs
 * `EntitlementEnforcementService` (the live `generalStorage`/
 * `videoStorage` plan-limit check, byte-precise). `PlansModule` depends
 * on neither `MediaModule` nor `AcademyModule`, so this stays a clean DAG.
 *
 * Exports `MediaService` as of Phase 4 (P24) — `LearningModule`'s
 * `AssignmentsService` needs it to wire real assignment-submission
 * attachments through this same R2 pipeline (`uploadForSubmission`), the
 * exact "reuse the existing architecture" instruction that phase's own
 * roadmap entry states explicitly, rather than a second, parallel upload
 * implementation. `MediaModule` depends on neither `LearningModule` nor
 * `CourseModule`, so `LearningModule` importing `MediaModule` stays a
 * clean, acyclic DAG.
 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthCoreModule } from '../identity/auth-core.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AcademyModule } from '../academy/academy.module';
import { PlansModule } from '../plans/plans.module';
import { PublicMediaController } from './controllers/public-media.controller';
import { MediaController } from './controllers/media.controller';
import { ProtectedMediaController } from './controllers/protected-media.controller';
import { VideoWebhookController } from './controllers/video-webhook.controller';
import { ProtectedMediaService } from './services/protected-media.service';
import { UsersRepository } from '../identity/repositories/users.repository';
import { VideoReconciliationService } from './services/video-reconciliation.service';
import { ProtectedMediaStorage } from './storage/protected-media-storage.provider';
import { AcademyOriginsService } from './video/academy-origins.service';
import { VIDEO_PROVIDER } from './video/video-provider.interface';
import { CloudflareStreamProvider } from './video/cloudflare-stream.provider';
import { FakeVideoProvider } from './video/fake-video.provider';
import { BasicVideoProvider } from './video/basic-video.provider';
import { VideoProviderRegistry } from './video/video-provider.registry';
import { VideoGateRevocationService } from './video/video-gate-revocation.service';
import { FlagsModule } from '../common/flags/flags.module';
import { ConfigService } from '@nestjs/config';
import type { VideoProviderConfig } from '../config/configuration';
import { MediaService } from './services/media.service';
import { MediaAssetsRepository } from './repositories/media-assets.repository';
import { MEDIA_STORAGE_PROVIDER } from './storage/media-storage.interface';
import { R2StorageProvider } from './storage/r2-media-storage.provider';
import { MediaProcessingProducer } from './queue/media-processing.producer';
import { MediaProcessingProcessor } from './queue/media-processing.processor';
import { MEDIA_PROCESSING_QUEUE } from './queue/media-processing.types';

@Module({
  imports: [
    AuthCoreModule,
    TenancyModule,
    AcademyModule,
    PlansModule,
    FlagsModule,
    BullModule.registerQueue({ name: MEDIA_PROCESSING_QUEUE }),
  ],
  controllers: [
    MediaController,
    PublicMediaController,
    // P64 Phase 2 — the protected tier and the provider webhook.
    ProtectedMediaController,
    VideoWebhookController,
  ],
  providers: [
    MediaService,
    MediaAssetsRepository,
    { provide: MEDIA_STORAGE_PROVIDER, useClass: R2StorageProvider },
    MediaProcessingProducer,
    MediaProcessingProcessor,
    // P64 Phase 2.
    ProtectedMediaStorage,
    ProtectedMediaService,
    VideoReconciliationService,
    // Stateless platform-scoped reads (`users` carries no RLS); resolves the
    // platform-owner id reconciliation reads as. Provided here rather than
    // importing `IdentityModule`, which would widen this module's graph.
    UsersRepository,
    AcademyOriginsService,
    CloudflareStreamProvider,
    FakeVideoProvider,
    BasicVideoProvider,
    VideoProviderRegistry,
    VideoGateRevocationService,
    {
      /*
       * The DEFAULT adapter, for the handful of call sites that predate
       * per-asset resolution (the webhook controller, which has no asset
       * until it has parsed one). Everything on the upload and playback
       * paths goes through `VideoProviderRegistry` instead — by TIER on
       * upload and by `media_assets.provider` on playback (AD-7) — which
       * is what lets Normal and Premium assets coexist in one academy
       * (D11).
       *
       * `FakeVideoProvider` refuses to run with `NODE_ENV=production`, so
       * a misconfigured production deployment fails loudly rather than
       * quietly serving unprotected local URLs.
       */
      provide: VIDEO_PROVIDER,
      inject: [
        ConfigService,
        CloudflareStreamProvider,
        BasicVideoProvider,
        FakeVideoProvider,
      ],
      useFactory: (
        configService: ConfigService,
        cloudflare: CloudflareStreamProvider,
        basic: BasicVideoProvider,
        fake: FakeVideoProvider,
      ) => {
        const config = configService.getOrThrow<VideoProviderConfig>('video');
        if (config.provider === 'cloudflare_stream') return cloudflare;
        if (config.provider === 'r2_worker') return basic;
        return fake;
      },
    },
  ],
  // `MEDIA_STORAGE_PROVIDER` is exported (P53) so the support module can
  // write ticket attachments through THE SAME R2 client and bucket rather
  // than constructing a second one — the same "one seam, reused" move
  // `BillingModule` already makes with `CredentialEncryptionService`.
  // `MediaService` itself is deliberately NOT what support uses: its
  // methods all create academy-scoped, quota-counted, library-visible
  // `MediaAsset` rows, which is exactly what a private ticket attachment
  // must not be (see the P53 migration's header).
  exports: [
    MediaService,
    // P64 Phase 3 — students upload submission attachments into the protected tier.
    ProtectedMediaService,
    MEDIA_STORAGE_PROVIDER,
    // P64 Phase 2 — `LearningModule`'s `ContentGrantSigner` signs through
    // exactly these two seams, so the grant path and the upload path can
    // never end up pointing at different buckets or different providers.
    ProtectedMediaStorage,
    VIDEO_PROVIDER,
    // P64 Phase 2 — `LearningModule`'s `ContentGrantSigner` resolves the
    // adapter per asset, so it needs the registry rather than one bound
    // provider.
    VideoProviderRegistry,
    AcademyOriginsService,
    VideoReconciliationService,
    // P64 Phase 2 — `LearningModule` publishes revocations to the Normal
    // tier's gate when an enrollment ends, a learner is blocked, a device
    // is removed or a session is taken over.
    VideoGateRevocationService,
  ],
})
export class MediaModule {}
