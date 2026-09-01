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
 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthCoreModule } from '../identity/auth-core.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AcademyModule } from '../academy/academy.module';
import { PlansModule } from '../plans/plans.module';
import { MediaController } from './controllers/media.controller';
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
    BullModule.registerQueue({ name: MEDIA_PROCESSING_QUEUE }),
  ],
  controllers: [MediaController],
  providers: [
    MediaService,
    MediaAssetsRepository,
    { provide: MEDIA_STORAGE_PROVIDER, useClass: R2StorageProvider },
    MediaProcessingProducer,
    MediaProcessingProcessor,
  ],
})
export class MediaModule {}
