/**
 * DashboardController — `GET organizations/:id/dashboard` and
 * `GET academies/:id/dashboard` (Phase 8).
 *
 * Two routes, two guards, two scopes — deliberately NOT one route with a
 * caller-supplied scope parameter. Which dashboard a caller gets is
 * decided entirely by which route they can actually reach:
 * `OrganizationMembershipGuard` proves organization membership for the
 * Organization Owner's whole-organization view;
 * `AcademyScopeGuard` resolves and proves ONE academy (transitively
 * through its own organization) for a Manager's narrowed view. Neither
 * route accepts an `academyId`/`organizationId` from the query string or
 * body at all, so there is nothing for a caller to tamper with — the
 * backend, not the frontend, decides what data exists for them.
 */
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { OrganizationMembershipGuard } from '../../tenancy/guards/organization-membership.guard';
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { DashboardService } from '../services/dashboard.service';
import type { DashboardOverviewResponse } from '../dto/dashboard-overview.contract';

@Controller()
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('organizations/:id/dashboard')
  @UseGuards(OrganizationMembershipGuard)
  async getForOrganization(@Req() request: Request): Promise<DashboardOverviewResponse> {
    return this.dashboardService.getForOrganization(
      request.tenantContext!.organizationId,
    );
  }

  @Get('academies/:id/dashboard')
  @UseGuards(AcademyScopeGuard)
  async getForAcademy(@Req() request: Request): Promise<DashboardOverviewResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.dashboardService.getForAcademy(organizationId, academyId);
  }
}
