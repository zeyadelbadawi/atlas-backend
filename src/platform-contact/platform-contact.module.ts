/**
 * PlatformContactModule — TASK 7, the Atlas marketing homepage's contact
 * form and the Platform Owner's inbox for it.
 *
 * A leaf module: nothing imports it. `CommunicationService` and
 * `AuditLogWriterService` come from their `@Global()` modules;
 * `RedisService` likewise.
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { PublicPlatformContactController } from './controllers/public-platform-contact.controller';
import { PlatformContactSubmissionsController } from './controllers/platform-contact-submissions.controller';
import { PlatformContactIntakeService } from './services/platform-contact-intake.service';
import { PlatformContactSubmissionsService } from './services/platform-contact-submissions.service';
import { PlatformContactSubmissionsRepository } from './repositories/platform-contact-submissions.repository';

@Module({
  imports: [AuthCoreModule, IdentityModule, TenancyModule],
  controllers: [PublicPlatformContactController, PlatformContactSubmissionsController],
  providers: [
    PlatformContactIntakeService,
    PlatformContactSubmissionsService,
    PlatformContactSubmissionsRepository,
  ],
})
export class PlatformContactModule {}
