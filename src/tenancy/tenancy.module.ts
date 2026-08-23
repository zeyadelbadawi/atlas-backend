/**
 * TenancyModule — Phase P2 (master plan §21). Wires the tenant-isolation
 * backbone: organizations/memberships repositories, `TenancyContextService`
 * (the RLS session-variable mechanism), the org self-service controller,
 * and `OrganizationMembershipGuard`.
 *
 * Imports `AuthCoreModule` (not `IdentityModule`) for `JwtAuthGuard` — see
 * `AuthCoreModule`'s doc comment for why: this keeps the module graph a
 * clean DAG (`IdentityModule` depends on `TenancyModule` for
 * `UserOrganizationsService`; the reverse would be a cycle).
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { OrganizationsController } from './controllers/organizations.controller';
import { OrganizationsService } from './services/organizations.service';
import { UserOrganizationsService } from './services/user-organizations.service';
import { TenancyContextService } from './services/tenancy-context.service';
import { OrganizationsRepository } from './repositories/organizations.repository';
import { OrganizationMembershipsRepository } from './repositories/organization-memberships.repository';
import { OrganizationMembershipGuard } from './guards/organization-membership.guard';

@Module({
  imports: [AuthCoreModule],
  controllers: [OrganizationsController],
  providers: [
    TenancyContextService,
    OrganizationsRepository,
    OrganizationMembershipsRepository,
    OrganizationsService,
    UserOrganizationsService,
    OrganizationMembershipGuard,
  ],
  exports: [
    TenancyContextService,
    OrganizationsRepository,
    OrganizationMembershipsRepository,
    UserOrganizationsService,
  ],
})
export class TenancyModule {}
