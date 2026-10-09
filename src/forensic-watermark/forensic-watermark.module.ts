/**
 * ForensicWatermarkModule — the mandatory per-viewer video watermark
 * (docs/FORENSIC_WATERMARK.md): code issuance and record keeping for every
 * player, the learner tamper report, and the Platform Owner lookup.
 *
 * A leaf with respect to the features that use it: `LearningModule` (lesson
 * grants, heartbeat, retention sweep) and `LiveSessionsModule` (live-class
 * joins) import it; it imports neither. `AuditLogWriterService` and
 * `RedisService` come from their `@Global()` modules.
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { OptionalJwtAuthGuard } from '../identity/guards/optional-jwt-auth.guard';
import { ForensicWatermarkService } from './services/forensic-watermark.service';
import { WatermarkSnapshotCipher } from './services/watermark-snapshot-cipher.service';
import { WatermarkLookupService } from './services/watermark-lookup.service';
import { WatermarkLookupRateLimiter } from './services/watermark-lookup.rate-limiter';
import { PlatformWatermarksController } from './controllers/platform-watermarks.controller';
import { WatermarkEventsController } from './controllers/watermark-events.controller';

@Module({
  imports: [AuthCoreModule, IdentityModule, TenancyModule],
  controllers: [PlatformWatermarksController, WatermarkEventsController],
  providers: [
    ForensicWatermarkService,
    WatermarkSnapshotCipher,
    WatermarkLookupService,
    WatermarkLookupRateLimiter,
    OptionalJwtAuthGuard,
  ],
  exports: [ForensicWatermarkService],
})
export class ForensicWatermarkModule {}
