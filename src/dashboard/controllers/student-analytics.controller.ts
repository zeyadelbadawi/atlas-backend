/**
 * StudentAnalyticsController — `GET organizations/:id/student-analytics`
 * and `GET academies/:id/student-analytics` (Phase 9, roadmap finding
 * CO11).
 *
 * Authorization is deliberately identical to `DashboardController`'s,
 * including the Phase 8 hardening that route needed, because the exposure
 * is the same shape: a tenant-scoped aggregate over one Academy or a whole
 * Organization.
 *
 *   - The organization route requires `tenant.dashboard.view`, the real
 *     owner-exclusive permission. `OrganizationMembershipGuard` alone
 *     proves only MEMBERSHIP, which an Academy Manager legitimately has —
 *     without this check a Manager of Academy A would read analytics
 *     covering Academy B.
 *   - The academy route delegates to
 *     `StudentAnalyticsService.getForAcademy`, which requires a real
 *     `academy_members` row for that specific academy (organization
 *     owners exempted), because `AcademyScopeGuard` grants Academy READ
 *     access on organization membership.
 *
 * The existing `AnalyticsController`/`PlatformMetricsController` are
 * Platform-Owner-only and are deliberately NOT reused here — this is a
 * separate, tenant-authorized surface rather than a relaxation of theirs.
 */
import { Controller, ForbiddenException, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { OrganizationMembershipGuard } from '../../tenancy/guards/organization-membership.guard';
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { StudentAnalyticsService } from '../services/student-analytics.service';
import type { StudentAnalyticsResponse } from '../dto/student-analytics.contract';

const ORGANIZATION_DASHBOARD_PERMISSION = 'tenant.dashboard.view';

@Controller()
@UseGuards(JwtAuthGuard)
export class StudentAnalyticsController {
  constructor(private readonly studentAnalyticsService: StudentAnalyticsService) {}

  @Get('organizations/:id/student-analytics')
  @UseGuards(OrganizationMembershipGuard)
  async getForOrganization(@Req() request: Request): Promise<StudentAnalyticsResponse> {
    const { organizationId, permissions } = request.tenantContext!;

    if (!permissions.includes(ORGANIZATION_DASHBOARD_PERMISSION)) {
      throw new ForbiddenException({ messageKey: 'errors.tenancy.notAMember' });
    }

    return this.studentAnalyticsService.getForOrganization(organizationId);
  }

  @Get('academies/:id/student-analytics')
  @UseGuards(AcademyScopeGuard)
  async getForAcademy(@Req() request: Request): Promise<StudentAnalyticsResponse> {
    const { academyId, organizationId, organizationPermissions } =
      request.academyContext!;

    return this.studentAnalyticsService.getForAcademy(
      organizationId,
      academyId,
      request.authContext!.userId,
      organizationPermissions.includes(ORGANIZATION_DASHBOARD_PERMISSION),
    );
  }
}
