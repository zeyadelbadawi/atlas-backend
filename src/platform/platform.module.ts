/**
 * PlatformModule — Phase P15 (master plan §21). Wires the Platform Owner
 * Control Plane: cross-tenant Organizations/Academies/Users read
 * surfaces, the Audit Log read side (the write side is the separate,
 * `@Global()` `AuditLogModule`), Support Operations, and Platform
 * Settings.
 *
 * Deliberately its own, DOWNSTREAM module — imports `TenancyModule`,
 * `AcademyModule`, `PlansModule`, `CourseModule`, `DomainModule`,
 * `WebsiteModule`, `ProvisioningModule`, `IdentityModule`, reusing every
 * repository/service each already exports rather than duplicating any of
 * their data access, the same pattern every prior phase module already
 * established. This is also why `OrganizationsController` (P2's own
 * `GET /organizations/:id` route) moved here — see `TenancyModule`'s own
 * doc comment for the full account of the real, confirmed frontend
 * contract collision this resolves.
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { LiveSessionsModule } from '../live-sessions/live-sessions.module';
import { AcademyModule } from '../academy/academy.module';
import { PlansModule } from '../plans/plans.module';
import { CourseModule } from '../course/course.module';
import { DomainModule } from '../domain/domain.module';
import { WebsiteModule } from '../website/website.module';
import { ProvisioningModule } from '../provisioning/provisioning.module';
import { MediaModule } from '../media/media.module';
import { OrganizationsController } from './controllers/organizations.controller';
import { PlatformZoomController } from './controllers/platform-zoom.controller';
import { PlatformZoomService } from './services/platform-zoom.service';
import { PlatformAcademiesController } from './controllers/platform-academies.controller';
import { PlatformUsersController } from './controllers/platform-users.controller';
import { AuditLogController } from './controllers/audit-log.controller';
import { AdminSubscriptionsController } from './controllers/admin-subscriptions.controller';
import { AdminSubscriptionsService } from './services/admin-subscriptions.service';
import { SupportCasesController } from './controllers/support-cases.controller';
import { TenantSupportCasesController } from './controllers/tenant-support-cases.controller';
import { PlatformSettingsController } from './controllers/platform-settings.controller';
import { PlatformAddOnsController } from './controllers/platform-add-ons.controller';
import { OrganizationsAccessGuard } from './guards/organizations-access.guard';
import { PlatformOrganizationsService } from './services/platform-organizations.service';
import { PlatformAcademiesService } from './services/platform-academies.service';
import { PlatformUsersService } from './services/platform-users.service';
import { AuditLogService } from './services/audit-log.service';
import { SupportCasesService } from './services/support-cases.service';
import { PlatformSettingsService } from './services/platform-settings.service';
import { PlatformAddOnsService } from './services/platform-add-ons.service';
import { PlatformUsersRepository } from './repositories/platform-users.repository';
import { SupportCasesRepository } from './repositories/support-cases.repository';
import { SupportCaseMessagesRepository } from './repositories/support-case-messages.repository';
import { SupportCaseMessageAttachmentsRepository } from './repositories/support-case-message-attachments.repository';
import { PlatformSettingsRepository } from './repositories/platform-settings.repository';

@Module({
  imports: [
    AuthCoreModule,
    IdentityModule,
    TenancyModule,
    AcademyModule,
    PlansModule,
    CourseModule,
    DomainModule,
    WebsiteModule,
    ProvisioningModule,
    LiveSessionsModule,
    // P53 — for `MEDIA_STORAGE_PROVIDER` only (support-ticket attachments
    // reuse the one R2 client), never for `MediaService`.
    MediaModule,
  ],
  controllers: [
    AdminSubscriptionsController,
    OrganizationsController,
    PlatformAcademiesController,
    PlatformZoomController,
    PlatformUsersController,
    AuditLogController,
    SupportCasesController,
    TenantSupportCasesController,
    PlatformSettingsController,
    PlatformAddOnsController,
  ],
  providers: [
    AdminSubscriptionsService,
    OrganizationsAccessGuard,
    PlatformOrganizationsService,
    PlatformAcademiesService,
    PlatformZoomService,
    PlatformUsersService,
    AuditLogService,
    SupportCasesService,
    PlatformSettingsService,
    PlatformAddOnsService,
    PlatformUsersRepository,
    SupportCasesRepository,
    SupportCaseMessagesRepository,
    SupportCaseMessageAttachmentsRepository,
    PlatformSettingsRepository,
  ],
})
export class PlatformModule {}
