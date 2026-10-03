/**
 * AcademyScopeGuard — the application-layer half of tenant isolation for
 * every `/academies/:id/*` route, mirroring `OrganizationMembershipGuard`'s
 * role but solving a problem that guard never had: tenant ownership here
 * is TRANSITIVE (`academy → organization_id`), and the only thing the
 * caller supplies is an academy id — never an organization id to seed
 * `runInTenantContext` with directly.
 *
 * Two-step bootstrap-then-reestablish flow:
 *   1. `runInUserContext` (only `app.current_user_id` set) — reads the
 *      academy row via `AcademiesRepository.findVisibleToUser`, which is
 *      visible only under the `academies_org_member_select` RLS policy
 *      (additive to the tenant-scoped one, see
 *      `20260823221639_p3_academy_scope_and_update_rls`). If this returns a
 *      row, the caller is a member of the owning organization; if not,
 *      it's ambiguous — academy doesn't exist, or exists in an org the
 *      caller has no membership in — collapsed into a single 403,
 *      deliberately, exactly like `OrganizationMembershipGuard` collapses
 *      "org doesn't exist" and "not a member" into one 403 (no enumeration
 *      oracle).
 *   2. Once `organizationId` is known, `runInTenantContext` is used to
 *      independently verify the caller's organization-membership row (not
 *      merely trusted from step 1's successful read) — this is what keeps
 *      RLS a genuinely independent third layer rather than a guard-layer
 *      decision the database rubber-stamps, matching
 *      `OrganizationsService.getById`'s documented discipline.
 *
 * W5 (finding F12) — ACADEMY-level, not organization-level. Organization
 * membership used to be sufficient here, which let the manager of academy
 * A read academy B's courses, media, stats and live sessions in the same
 * organization (an intra-organization IDOR: RLS is organization-scoped and
 * cannot separate academies). The guard now resolves the caller's role IN
 * THIS ACADEMY and refuses everyone else:
 *   - the organization OWNER resolves to `owner` for every academy in the
 *     organization (implicit, no `academy_members` row needed);
 *   - anyone else needs an ACTIVE `academy_members` row for this academy,
 *     whose role becomes `academyContext.academyRole`;
 *   - an inactive/pending row, or no row, is the same 403 as "not a
 *     member". Nothing is cached: every request re-reads both rows, so a
 *     revoked membership is refused on the very next request.
 * Routes that need a narrower tier declare it with `@AcademyRoles(...)`
 * (`../decorators/academy-roles.decorator.ts`); a role outside that list
 * gets `errors.academy.insufficientRole`. WRITE authorization is still
 * re-checked by the services (`assertCanManage` & co.) — this guard is the
 * first layer, not the only one.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AcademyMemberRole } from '@prisma/client';
import type { Request } from 'express';
import { ACADEMY_ROLES_KEY } from '../decorators/academy-roles.decorator';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { OrganizationMembershipsRepository } from '../../tenancy/repositories/organization-memberships.repository';
import { AcademiesRepository } from '../repositories/academies.repository';
import { AcademyMembersRepository } from '../repositories/academy-members.repository';

export interface AcademyContext {
  readonly academyId: string;
  readonly organizationId: string;
  readonly organizationMembershipId: string;
  readonly organizationRole: string;
  /**
   * The caller's real organization-membership permission strings (Phase 8)
   * — already read from the database by this guard's own membership
   * lookup, so exposing them here costs no extra query and saves every
   * consumer from re-fetching the same row. Mirrors what
   * `OrganizationMembershipGuard` has always put on `tenantContext`.
   */
  readonly organizationPermissions: readonly string[];
  /**
   * W5 — the caller's role IN THIS ACADEMY. `owner` for the organization
   * owner (implicit), otherwise the role of their ACTIVE `academy_members`
   * row. Never derived from the organization role of a non-owner.
   */
  readonly academyRole: AcademyMemberRole;
  /** Why `academyRole` holds: the organization-owner rule, or a real active academy membership row. */
  readonly academyRoleSource: 'organization_owner' | 'academy_membership';
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `AcademyScopeGuard` once organization membership is verified. */
    academyContext?: AcademyContext;
  }
}

@Injectable()
export class AcademyScopeGuard implements CanActivate {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly academiesRepository: AcademiesRepository,
    private readonly membershipsRepository: OrganizationMembershipsRepository,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const academyId = request.params.id;
    const userId = request.authContext?.userId;

    if (!academyId || !userId) {
      throw new ForbiddenException({ messageKey: 'errors.tenancy.notAMember' });
    }

    const bootstrapped = await this.tenancyContextService.runInUserContext(userId, (tx) =>
      this.academiesRepository.findVisibleToUser(tx, academyId),
    );

    if (!bootstrapped) {
      throw new ForbiddenException({ messageKey: 'errors.tenancy.notAMember' });
    }

    const organizationId = bootstrapped.organizationId;
    // Both rows are read in the re-established tenant context, on every
    // request — no role is ever cached, so revocation is immediate.
    const { membership, academyMembership } =
      await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => ({
        membership: await this.membershipsRepository.findForUserInOrganization(
          tx,
          organizationId,
          userId,
        ),
        academyMembership: await this.academyMembersRepository.findForUserInAcademy(
          tx,
          academyId,
          userId,
        ),
      }));

    let academyRole: AcademyMemberRole;
    let academyRoleSource: AcademyContext['academyRoleSource'];
    if (membership?.role === 'owner') {
      // The organization owner owns every academy of their organization.
      academyRole = 'owner';
      academyRoleSource = 'organization_owner';
    } else if (academyMembership && academyMembership.status === 'active') {
      // P64 Phase 1 — an ACTIVE academy_members row (instructor/manager/
      // owner granted at the academy level, including seeded staff whose
      // organization membership was never written) scopes the caller to
      // THIS academy only.
      academyRole = academyMembership.role;
      academyRoleSource = 'academy_membership';
    } else {
      // An organization member who is not staff of THIS academy (or whose
      // academy membership is inactive/pending) — the same 403 as an
      // outsider, so the response is no oracle for which academies exist.
      throw new ForbiddenException({ messageKey: 'errors.tenancy.notAMember' });
    }

    const requiredRoles = this.reflector.getAllAndOverride<
      readonly AcademyMemberRole[] | undefined
    >(ACADEMY_ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (requiredRoles && !requiredRoles.includes(academyRole)) {
      throw new ForbiddenException({ messageKey: 'errors.academy.insufficientRole' });
    }

    request.academyContext = membership
      ? {
          academyId,
          organizationId,
          organizationMembershipId: membership.id,
          organizationRole: membership.role,
          organizationPermissions: membership.permissions,
          academyRole,
          academyRoleSource,
        }
      : {
          academyId,
          organizationId,
          organizationMembershipId: '',
          organizationRole: `academy_${academyRole}`,
          organizationPermissions: [],
          academyRole,
          academyRoleSource,
        };
    return true;
  }
}
