/**
 * PlatformContactModule — TASK 7, the Atlas marketing homepage's contact
 * form and the Platform Owner's inbox for it.
 *
 * A leaf module: nothing imports it. `CommunicationService` and
 * `AuditLogWriterService` come from their `@Global()` modules;
 * `RedisService` likewise.
 *
 * B0-SUP-04 — owns the enquiry retention sweep: its own queue, ONE
 * processor, one repeatable job (`PlatformContactRetentionScheduler`).
 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { PublicPlatformContactController } from './controllers/public-platform-contact.controller';
import { PlatformContactSubmissionsController } from './controllers/platform-contact-submissions.controller';
import { PlatformContactIntakeService } from './services/platform-contact-intake.service';
import { PlatformContactSubmissionsService } from './services/platform-contact-submissions.service';
import { PlatformContactSubmissionsRepository } from './repositories/platform-contact-submissions.repository';
import { PlatformContactRetentionService } from './services/platform-contact-retention.service';
import { PlatformContactRetentionProcessor } from './queue/platform-contact-retention.processor';
import { PlatformContactRetentionScheduler } from './queue/platform-contact-retention.scheduler';
import { PLATFORM_CONTACT_RETENTION_QUEUE } from './platform-contact.constants';

@Module({
  imports: [
    AuthCoreModule,
    IdentityModule,
    TenancyModule,
    BullModule.registerQueue({ name: PLATFORM_CONTACT_RETENTION_QUEUE }),
  ],
  controllers: [PublicPlatformContactController, PlatformContactSubmissionsController],
  providers: [
    PlatformContactIntakeService,
    PlatformContactSubmissionsService,
    PlatformContactSubmissionsRepository,
    PlatformContactRetentionService,
    PlatformContactRetentionProcessor,
    PlatformContactRetentionScheduler,
  ],
  // Exported so the e2e suite can drive a retention run directly.
  exports: [PlatformContactRetentionService],
})
export class PlatformContactModule {}
