/**
 * UserOrganizationsService — resolves the real
 * `CurrentUser.organizations`/`.organizationMemberships` data (master plan
 * §21 Phase P2, this phase's §20 "CurrentUser organization data"). Used by
 * the identity module's session/profile flows (`AuthService.issueSession`,
 * `UsersService.getCurrent`) — a one-directional dependency (identity
 * depends on tenancy, never the reverse), since "who is this user" needs
 * "which organizations", not the other way around.
 */
import { Injectable } from '@nestjs/common';
import { TenancyContextService } from './tenancy-context.service';
import { OrganizationsRepository } from '../repositories/organizations.repository';
import { OrganizationMembershipsRepository } from '../repositories/organization-memberships.repository';
import type { OrganizationMembershipResponse } from '../dto/organization-membership.contract';

@Injectable()
export class UserOrganizationsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly organizationsRepository: OrganizationsRepository,
    private readonly membershipsRepository: OrganizationMembershipsRepository,
  ) {}

  /**
   * Both queries run inside the SAME `runInUserContext` transaction, so
   * both the `organization_memberships_self_select` and
   * `organizations_member_select` RLS policies apply together and agree —
   * this is a genuinely cross-organization read (a user may belong to
   * several), which is exactly why it uses the user-scoped session
   * variable instead of the single-tenant `app.current_organization_id`.
   */
  async getMembershipsForUser(
    userId: string,
  ): Promise<readonly OrganizationMembershipResponse[]> {
    const { memberships, organizationNamesById } =
      await this.tenancyContextService.runInUserContext(userId, async (tx) => {
        const memberships = await this.membershipsRepository.findAllForUser(tx, userId);
        const organizations = await this.organizationsRepository.findAllVisible(tx);
        const organizationNamesById = new Map(
          organizations.map((org) => [org.id, org.name]),
        );
        return { memberships, organizationNamesById };
      });

    return memberships.map((membership) => ({
      organizationId: membership.organizationId,
      organizationName: organizationNamesById.get(membership.organizationId) ?? '',
      role: membership.role,
      permissions: membership.permissions,
      isPrimary: membership.isPrimary,
      joinedAt: membership.joinedAt.toISOString(),
    }));
  }
}
