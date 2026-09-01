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
 *
 * Phase 2 note — for the exact same reason, `POST /organizations` (this
 * module's OWN controller, previously declared here) moved downstream
 * into `PlansModule` too: it now needs
 * `OrganizationSubscriptionBootstrapService` to give every brand-new
 * Organization a real trial subscription atomically at creation time
 * (Decision 6), and `PlansModule` already depends on `TenancyModule`
 * one-directionally, so it can safely hold that controller.
 * `OrganizationsService.create` itself gained one new OPTIONAL parameter
 * (`onCreated`, a plain transaction-scoped callback) for exactly this —
 * see that method's own doc comment — so this module still imports
 * nothing new and stays exactly as dependency-free as it always was.
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { OrganizationsService } from './services/organizations.service';
import { UserOrganizationsService } from './services/user-organizations.service';
import { TenancyContextService } from './services/tenancy-context.service';
import { OrganizationsRepository } from './repositories/organizations.repository';
import { OrganizationMembershipsRepository } from './repositories/organization-memberships.repository';
import { AcademyStudentsRepository } from './repositories/academy-students.repository';
import { OrganizationMembershipGuard } from './guards/organization-membership.guard';

@Module({
  imports: [AuthCoreModule],
  // Phase P19's `POST /organizations` controller moved into `PlansModule`
  // in Phase 2 (see this file's own header comment) — every `GET` route
  // for this resource already lived in `PlatformModule` per the P15 note
  // above, so this module now declares no controllers of its own at all.
  controllers: [],
  providers: [
    TenancyContextService,
    OrganizationsRepository,
    OrganizationMembershipsRepository,
    // Phase 1 (Extended Scope, dependency D) — lives here, not
    // `AcademyModule`, so `IdentityModule` (self-registration) can use it
    // too without a circular import; see the repository's own doc comment.
    AcademyStudentsRepository,
    OrganizationsService,
    UserOrganizationsService,
    OrganizationMembershipGuard,
  ],
  exports: [
    TenancyContextService,
    OrganizationsRepository,
    OrganizationMembershipsRepository,
    AcademyStudentsRepository,
    UserOrganizationsService,
    // Phase P15 additions — both reused verbatim, unmodified, by
    // `PlatformModule`'s `OrganizationsController` (see this file's own
    // header comment).
    OrganizationsService,
    OrganizationMembershipGuard,
  ],
})
export class TenancyModule {}
