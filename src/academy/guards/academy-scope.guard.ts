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
 * Read access to an Academy (this guard's only job) is governed by
 * ORGANIZATION membership — see the migration's doc comment for why this
 * does not "assume organization owner = automatic unrestricted Academy
 * Owner": that instruction is about WRITE authorization (owner/
 * administrator-only actions), enforced separately by
 * `AcademiesService.assertCanManage`, never by this guard.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { OrganizationMembershipsRepository } from '../../tenancy/repositories/organization-memberships.repository';
import { AcademiesRepository } from '../repositories/academies.repository';

export interface AcademyContext {
  readonly academyId: string;
  readonly organizationId: string;
  readonly organizationMembershipId: string;
  readonly organizationRole: string;
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
    const membership = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.membershipsRepository.findForUserInOrganization(tx, organizationId, userId),
    );

    if (!membership) {
      // Structurally unreachable if the bootstrap read above (governed by
      // the identical membership fact) succeeded — kept as a real check,
      // not an assertion, matching `OrganizationsService.getById`'s own
      // "never assume the guard's read still holds" rule.
      throw new ForbiddenException({ messageKey: 'errors.tenancy.notAMember' });
    }

    request.academyContext = {
      academyId,
      organizationId,
      organizationMembershipId: membership.id,
      organizationRole: membership.role,
    };
    return true;
  }
}
