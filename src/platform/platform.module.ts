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
import { AcademyModule } from '../academy/academy.module';
import { PlansModule } from '../plans/plans.module';
import { CourseModule } from '../course/course.module';
import { DomainModule } from '../domain/domain.module';
import { WebsiteModule } from '../website/website.module';
import { ProvisioningModule } from '../provisioning/provisioning.module';
import { OrganizationsController } from './controllers/organizations.controller';
import { PlatformAcademiesController } from './controllers/platform-academies.controller';
import { PlatformUsersController } from './controllers/platform-users.controller';
import { AuditLogController } from './controllers/audit-log.controller';
import { SupportCasesController } from './controllers/support-cases.controller';
import { PlatformSettingsController } from './controllers/platform-settings.controller';
import { OrganizationsAccessGuard } from './guards/organizations-access.guard';
import { PlatformOrganizationsService } from './services/platform-organizations.service';
import { PlatformAcademiesService } from './services/platform-academies.service';
import { PlatformUsersService } from './services/platform-users.service';
import { AuditLogService } from './services/audit-log.service';
import { SupportCasesService } from './services/support-cases.service';
import { PlatformSettingsService } from './services/platform-settings.service';
import { PlatformUsersRepository } from './repositories/platform-users.repository';
import { SupportCasesRepository } from './repositories/support-cases.repository';
import { SupportCaseMessagesRepository } from './repositories/support-case-messages.repository';
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
  ],
  controllers: [
    OrganizationsController,
    PlatformAcademiesController,
    PlatformUsersController,
    AuditLogController,
    SupportCasesController,
    PlatformSettingsController,
  ],
  providers: [
    OrganizationsAccessGuard,
    PlatformOrganizationsService,
    PlatformAcademiesService,
    PlatformUsersService,
    AuditLogService,
    SupportCasesService,
    PlatformSettingsService,
    PlatformUsersRepository,
    SupportCasesRepository,
    SupportCaseMessagesRepository,
    PlatformSettingsRepository,
  ],
})
export class PlatformModule {}
