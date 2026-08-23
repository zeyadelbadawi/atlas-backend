/**
 * OrganizationMembershipGuard — the application-layer half of tenant
 * isolation (master plan §7 point 3: "Application-layer scoping is still
 * mandatory, not redundant"). Runs after `JwtAuthGuard` on every
 * `/organizations/:id/*` route.
 *
 * Resolves the requested organization id from the route param — never
 * trusted on its own — and verifies the authenticated user actually has a
 * membership row for it. That verification query runs *inside* the same
 * RLS tenant context it's establishing (`TenancyContextService`), so this
 * guard and the database's own RLS policy are, deliberately, the same
 * check: if the membership doesn't exist, the query returns nothing
 * regardless of any bug in this guard's own logic. No membership → 403,
 * never a silent pass-through, matching `RouteGuard`'s fail-closed
 * frontend behavior exactly.
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

export interface TenantContext {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly role: string;
  readonly permissions: readonly string[];
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `OrganizationMembershipGuard` once membership is verified. */
    tenantContext?: TenantContext;
  }
}

@Injectable()
export class OrganizationMembershipGuard implements CanActivate {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly membershipsRepository: OrganizationMembershipsRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const organizationId = request.params.id;
    const userId = request.authContext?.userId;

    // `JwtAuthGuard` throws before this guard ever runs if `authContext` is
    // unset — this is defensive, not a real branch under normal routing.
    if (!organizationId || !userId) {
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

    request.tenantContext = {
      organizationId,
      membershipId: membership.id,
      role: membership.role,
      permissions: membership.permissions,
    };
    return true;
  }
}
