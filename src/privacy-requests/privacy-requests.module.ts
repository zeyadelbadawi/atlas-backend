/**
 * PrivacyRequestsModule — B0-SEC-13, request-based data deletion and data
 * export. A leaf module: `CommunicationService`, `PlatformOwnerAlertService`
 * and `AuditLogWriterService` come from their `@Global()` modules; the
 * emailed-code challenge and the account deletion come from `IdentityModule`.
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { PrivacyRequestsController } from './controllers/privacy-requests.controller';
import { PlatformPrivacyRequestsController } from './controllers/platform-privacy-requests.controller';
import { PrivacyRequestsService } from './services/privacy-requests.service';
import { PlatformPrivacyRequestsService } from './services/platform-privacy-requests.service';

@Module({
  imports: [AuthCoreModule, IdentityModule, TenancyModule],
  controllers: [PrivacyRequestsController, PlatformPrivacyRequestsController],
  providers: [PrivacyRequestsService, PlatformPrivacyRequestsService],
})
export class PrivacyRequestsModule {}
