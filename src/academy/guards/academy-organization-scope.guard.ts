/**
 * AcademyOrganizationScopeGuard — guards the two flat, non-`:id` Academy
 * routes: `GET /academies` (list) and `POST /academies` (create). Neither
 * carries an academy id to resolve tenancy from (there is no academy yet
 * for `POST`, and `GET` is a cross-academy list within one organization),
 * so both require the caller-supplied `organizationId` (query param for
 * GET, body field for POST — see `CreateAcademyDto`'s doc comment for why
 * this field exists at all) and verify it the same way
 * `OrganizationMembershipGuard` verifies `/organizations/:id/*`: a real
 * membership row, checked inside the same RLS tenant context it
 * establishes.
 *
 * Deliberately mirrors `OrganizationMembershipGuard` rather than reusing it
 * directly — that guard reads `request.params.id`, which does not exist on
 * either of these routes.
 */
import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { OrganizationMembershipsRepository } from '../../tenancy/repositories/organization-memberships.repository';
import type { TenantContext } from '../../tenancy/guards/organization-membership.guard';

@Injectable()
export class AcademyOrganizationScopeGuard implements CanActivate {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly membershipsRepository: OrganizationMembershipsRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const organizationId =
      request.method === 'GET'
        ? (request.query.organizationId as string | undefined)
        : (request.body as { organizationId?: string } | undefined)?.organizationId;
    const userId = request.authContext?.userId;

    // Guards run before the `ValidationPipe` in Nest's request lifecycle,
    // so a missing `organizationId` is caught here directly, not assumed
    // already rejected by `CreateAcademyDto`/`ListAcademiesQueryDto` — this
    // guard cannot rely on validation that hasn't run yet. Distinct from
    // "not a member" below: this is a malformed request, not an
    // authorization decision.
    if (!organizationId) {
      throw new BadRequestException({
        messageKey: 'errors.validation.organizationIdRequired',
      });
    }

    // `JwtAuthGuard` throws before this guard runs if `authContext` is
    // unset — defensive, not reachable in normal routing.
    if (!userId) {
      throw new ForbiddenException({ messageKey: 'errors.tenancy.notAMember' });
    }

    const membership = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.membershipsRepository.findForUserInOrganization(tx, organizationId, userId),
    );

    if (!membership) {
      throw new ForbiddenException({ messageKey: 'errors.tenancy.notAMember' });
    }

    const tenantContext: TenantContext = {
      organizationId,
      membershipId: membership.id,
      role: membership.role,
      permissions: membership.permissions,
    };
    request.tenantContext = tenantContext;
    return true;
  }
}
