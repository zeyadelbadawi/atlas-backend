/**
 * DashboardController — `GET organizations/:id/dashboard` and
 * `GET academies/:id/dashboard` (Phase 8).
 *
 * Two routes, two scopes — deliberately NOT one route with a
 * caller-supplied scope parameter. Neither route accepts an `academyId`/
 * `organizationId` from the query string or body at all, so there is
 * nothing for a caller to tamper with: the backend, not the frontend,
 * decides what data exists for them.
 *
 * The organization route needs MORE than `OrganizationMembershipGuard`.
 * That guard proves the caller has *a* membership in the organization —
 * which an Academy Manager legitimately does (`AcademiesService.addManager`
 * creates one, with the manager permission set). Membership alone would
 * therefore have let a Manager of Academy A read organization-wide
 * aggregates covering Academy B — exactly what the roadmap's Decision 2
 * forbids ("A Manager ... must never see ... Academy B or Academy C ...
 * enforced at the backend/API/database authorization level, not only
 * through frontend navigation"). Found in real production verification,
 * where a Manager's token successfully read the organization dashboard.
 *
 * So the organization route additionally requires `tenant.dashboard.view`
 * — the real, already-existing owner-exclusive permission string from
 * `ORGANIZATION_OWNER_PERMISSIONS` (it is deliberately absent from
 * `ORGANIZATION_MANAGER_PERMISSIONS`; see that catalog's own doc comment).
 * No new permission or role concept is invented here, and the check reads
 * the membership row the guard itself just resolved from the database,
 * never anything client-supplied. A Manager keeps full access to their own
 * Academy's dashboard through the academy route below.
 */
import { Controller, ForbiddenException, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { OrganizationMembershipGuard } from '../../tenancy/guards/organization-membership.guard';
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { DashboardService } from '../services/dashboard.service';
import type { DashboardOverviewResponse } from '../dto/dashboard-overview.contract';

/** The owner-exclusive string `ORGANIZATION_OWNER_PERMISSIONS` adds on top of the manager set — see this class's own doc comment. */
const ORGANIZATION_DASHBOARD_PERMISSION = 'tenant.dashboard.view';

@Controller()
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('organizations/:id/dashboard')
  @UseGuards(OrganizationMembershipGuard)
  async getForOrganization(@Req() request: Request): Promise<DashboardOverviewResponse> {
    const { organizationId, permissions } = request.tenantContext!;

    if (!permissions.includes(ORGANIZATION_DASHBOARD_PERMISSION)) {
      throw new ForbiddenException({ messageKey: 'errors.tenancy.notAMember' });
    }

    return this.dashboardService.getForOrganization(organizationId);
  }

  @Get('academies/:id/dashboard')
  @UseGuards(AcademyScopeGuard)
  async getForAcademy(@Req() request: Request): Promise<DashboardOverviewResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.dashboardService.getForAcademy(organizationId, academyId);
  }
}
