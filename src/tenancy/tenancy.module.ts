/**
 * TenancyModule — Phase P2 (master plan §21). Wires the tenant-isolation
 * backbone: organizations/memberships repositories, `TenancyContextService`
 * (the RLS session-variable mechanism), and `OrganizationMembershipGuard`.
 *
 * Imports `AuthCoreModule` (not `IdentityModule`) for `JwtAuthGuard` — see
 * `AuthCoreModule`'s doc comment for why: this keeps the module graph a
 * clean DAG (`IdentityModule` depends on `TenancyModule` for
 * `UserOrganizationsService`; the reverse would be a cycle).
 *
 * Phase P15 note — `OrganizationsController` (the real `GET /organizations`/
 * `GET /organizations/:id` routes) now lives in `PlatformModule`, not
 * here. `PlatformOrganizationService` (atlas frontend) reuses this exact
 * `organizations` resource for its own cross-tenant Platform Owner view —
 * a real, confirmed collision with this phase's own `OrganizationService`
 * on the identical `GET /organizations/:id` route (see
 * `OrganizationsAccessGuard`'s own doc comment for the full account).
 * Resolving it needed `PlansModule`/`AcademyModule` (for
 * `TenantSubscriptionService`/academy-membership data), and this module
 * cannot import either without a cycle (`PlansModule`/`AcademyModule`
 * both already depend on `TenancyModule`) — so the controller moved
 * downstream into `PlatformModule`, which already depends on
 * `TenancyModule` one-directionally. `OrganizationsService` (this
 * module's own, narrower P2 logic) is now exported so `PlatformModule`'s
 * controller can still call it, UNMODIFIED, for the non-Platform-Owner
 * branch — every byte of P2's own tenant-member behavior is preserved,
 * just invoked from a different module.
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { OrganizationsService } from './services/organizations.service';
import { UserOrganizationsService } from './services/user-organizations.service';
import { TenancyContextService } from './services/tenancy-context.service';
import { OrganizationsRepository } from './repositories/organizations.repository';
import { OrganizationMembershipsRepository } from './repositories/organization-memberships.repository';
import { OrganizationMembershipGuard } from './guards/organization-membership.guard';

@Module({
  imports: [AuthCoreModule],
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
    // Phase P15 additions — both reused verbatim, unmodified, by
    // `PlatformModule`'s `OrganizationsController` (see this file's own
    // header comment).
    OrganizationsService,
    OrganizationMembershipGuard,
  ],
})
export class TenancyModule {}
