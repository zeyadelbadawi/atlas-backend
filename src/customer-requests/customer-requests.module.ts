/**
 * CustomerRequestsModule — custom services an academy asks Atlas for, and
 * the Platform Owner console that handles them. A leaf module.
 * `CommunicationService` and `AuditLogWriterService` come from their
 * `@Global()` modules.
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AcademyModule } from '../academy/academy.module';
import { AcademyCustomerRequestsController } from './controllers/academy-customer-requests.controller';
import { PlatformCustomerRequestsController } from './controllers/platform-customer-requests.controller';
import { CustomerRequestsService } from './services/customer-requests.service';
import { PlatformCustomerRequestsService } from './services/platform-customer-requests.service';
import { CustomerRequestNotifierService } from './services/customer-request-notifier.service';

@Module({
  imports: [AuthCoreModule, IdentityModule, TenancyModule, AcademyModule],
  controllers: [AcademyCustomerRequestsController, PlatformCustomerRequestsController],
  providers: [
    CustomerRequestsService,
    PlatformCustomerRequestsService,
    CustomerRequestNotifierService,
  ],
})
export class CustomerRequestsModule {}
