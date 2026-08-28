/**
 * AcademyModule — Phase P3 (master plan §21). Wires the Academy Management
 * surface: repositories, `AcademiesService`, the two guard shapes, and the
 * controller.
 *
 * Imports `AuthCoreModule` for `JwtAuthGuard` (not `IdentityModule` — same
 * DAG-cleanliness reason as `TenancyModule`) and `TenancyModule` for
 * `TenancyContextService`/`OrganizationMembershipsRepository` — this module
 * reuses P2's tenancy backbone rather than duplicating any part of it, per
 * the explicit P3 constraint against a second tenant/membership/session
 * mechanism.
 *
 * `AcademyScopeGuard` is exported (added in P5) so `CourseModule` can
 * reuse it verbatim for every `academies/:id/courses/*` route — Course
 * routes always resolve `:id` as the ACADEMY id, the exact case this guard
 * already handles, so no new guard was written for P5 at all.
 *
 * `AcademiesService` is additionally exported as of Phase P14 —
 * `ProvisioningModule`'s `academy` orchestration step calls
 * `AcademiesService.create` directly, reusing the complete, already-tested
 * slug-conflict-handling/membership-creation logic verbatim rather than
 * duplicating any part of it (this phase's explicit instruction).
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AcademiesController } from './controllers/academies.controller';
import { AcademiesService } from './services/academies.service';
import { AcademiesRepository } from './repositories/academies.repository';
import { AcademyMembersRepository } from './repositories/academy-members.repository';
import { AcademyOrganizationScopeGuard } from './guards/academy-organization-scope.guard';
import { AcademyScopeGuard } from './guards/academy-scope.guard';

@Module({
  imports: [AuthCoreModule, TenancyModule],
  controllers: [AcademiesController],
  providers: [
    AcademiesRepository,
    AcademyMembersRepository,
    AcademiesService,
    AcademyOrganizationScopeGuard,
    AcademyScopeGuard,
  ],
  exports: [
    AcademiesRepository,
    AcademyMembersRepository,
    AcademyScopeGuard,
    AcademiesService,
  ],
})
export class AcademyModule {}
