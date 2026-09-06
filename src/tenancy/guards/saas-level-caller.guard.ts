/**
 * SaasLevelCallerGuard — foundational-audit fix (ATLAS_FOUNDATIONAL_AUTH_
 * TENANCY_AUDIT.md, Fix A). Implements the guard the roadmap's Phase 1
 * always described but never built: "distinguishes a genuine SaaS-level
 * caller (an Organization Owner, or a brand-new user who has not yet
 * completed self-service onboarding into becoming an Owner) from an
 * Academy-level caller (Manager, Instructor, Student)" (Decision 5).
 * Applied to `PlansController`, `AddOnsController`, and
 * `OrganizationsController.create` — the exact three endpoints the
 * roadmap names and the exact three the audit found unguarded beyond
 * `JwtAuthGuard`.
 *
 * The distinguishing signal reuses two tables that already exist and are
 * already correctly written — no new table, no RLS change:
 *   - `organization_memberships` (`OrganizationMembershipsRepository.
 *     findAllForUser`, the same query `UserOrganizationsService` already
 *     uses for `CurrentUser.organizations`) — a caller with an `owner`
 *     row here IS a genuine SaaS-level caller (Manager/Instructor rows
 *     never carry `role: 'owner'`, confirmed against
 *     `organization-permissions.constants.ts`: `addManager`/
 *     `addInstructor` only ever grant `'manager'`/`'instructor'`).
 *   - `academy_students` (`AcademyStudentsRepository.existsForUser`) — a
 *     caller with ANY row here is a real, Academy-scoped Student (Phase 1
 *     Extended Scope, dependency D) and must never be treated as
 *     onboarding-eligible, regardless of holding zero
 *     `organization_memberships` rows.
 *
 * Both queries run inside the SAME `runInUserContext` transaction as
 * `UserOrganizationsService.getMembershipsForUser` already does, so the
 * `organization_memberships_self_select`/`academy_students_self_select`
 * RLS policies apply without needing any tenant context to be open yet —
 * exactly the "no `:id` yet, nothing to resolve a tenant from" situation
 * `OrganizationsController.create`'s own doc comment already describes.
 *
 * ALSO checks `academy_members` (`AcademyStaffRepository`, a narrow
 * existence check living in this module for the same cross-module reason
 * `AcademyStudentsRepository` does — see its own doc comment) as defense
 * in depth. In every REAL grant path (`AcademiesService.addManager`/
 * `addInstructor`), an `academy_members` row is always created
 * atomically alongside a real `organization_memberships` row, so the
 * `organization_memberships` check alone already catches a genuine
 * Manager/Instructor. This second check exists because the audit's own
 * regression testing found a REAL, currently-live counter-example: a
 * seed-data-only `academy_members` row created by direct upsert (never
 * through the real grant service) with NO matching
 * `organization_memberships` row — which, without this check, is
 * indistinguishable from a genuinely brand-new, never-affiliated signup
 * and would incorrectly pass.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { TenancyContextService } from '../services/tenancy-context.service';
import { OrganizationMembershipsRepository } from '../repositories/organization-memberships.repository';
import { AcademyStudentsRepository } from '../repositories/academy-students.repository';
import { AcademyStaffRepository } from '../repositories/academy-staff.repository';

@Injectable()
export class SaasLevelCallerGuard implements CanActivate {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly membershipsRepository: OrganizationMembershipsRepository,
    private readonly academyStudentsRepository: AcademyStudentsRepository,
    private readonly academyStaffRepository: AcademyStaffRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const userId = request.authContext?.userId;

    // `JwtAuthGuard` throws before this guard ever runs if `authContext`
    // is unset — this is defensive, not a real branch under normal
    // routing.
    if (!userId) {
      throw new ForbiddenException({ messageKey: 'errors.tenancy.saasLevelCallerOnly' });
    }

    const isSaasLevelCaller = await this.tenancyContextService.runInUserContext(
      userId,
      async (tx) => {
        const memberships = await this.membershipsRepository.findAllForUser(tx, userId);
        if (memberships.some((membership) => membership.role === 'owner')) {
          return true;
        }
        if (memberships.length > 0) {
          // A real, non-owner organization role (manager/instructor) —
          // an Academy-level caller, never eligible for a second,
          // independent SaaS-onboarding action here.
          return false;
        }

        // Zero organization memberships — legitimate for a genuinely
        // brand-new, not-yet-onboarded signup (Decision 5), but NOT for a
        // real, staff/owner-created or self-registered Student, and NOT
        // for a real Academy staff member (Manager/Instructor) either —
        // see this guard's own doc comment for why both are checked.
        const [isAcademyStudent, isAcademyStaff] = await Promise.all([
          this.academyStudentsRepository.existsForUser(tx, userId),
          this.academyStaffRepository.existsForUser(tx, userId),
        ]);
        return !isAcademyStudent && !isAcademyStaff;
      },
    );

    if (!isSaasLevelCaller) {
      throw new ForbiddenException({ messageKey: 'errors.tenancy.saasLevelCallerOnly' });
    }

    return true;
  }
}
