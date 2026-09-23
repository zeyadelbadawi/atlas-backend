/**
 * AcademyReportsController — `academies/:id/reports/*` (P64 Phase 4, master
 * plan §D.6/§E.5/§L). Same guard shape as `StudentAnalyticsController`'s
 * academy route: `JwtAuthGuard` + `ManagementSurfaceGuard` (a management
 * surface, never the learner portal) + `AcademyScopeGuard` (resolves the
 * academy and the caller's organization permissions). Role narrowing to
 * owner/administrator/manager happens in the service, mirrored by RLS —
 * see `AcademyReportsService`'s class doc for the two-gate design.
 *
 * Quota usage is deliberately NOT a route here: `GET organizations/:id/usage`
 * already exists and the reports page reads it directly.
 */
import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { AcademyReportsService } from '../services/academy-reports.service';
import { AcademyReportsQueryDto } from '../dto/academy-reports-query.dto';
import type {
  AcademyIntegrityReportResponse,
  AcademySharingReportResponse,
} from '../dto/academy-reports.contract';

/** The same organization-level permission `StudentAnalyticsController` treats as "sees everything in the org". */
const ORGANIZATION_DASHBOARD_PERMISSION = 'tenant.dashboard.view';

@Controller()
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard)
export class AcademyReportsController {
  constructor(private readonly academyReportsService: AcademyReportsService) {}

  @Get('academies/:id/reports/integrity')
  @UseGuards(AcademyScopeGuard)
  async getIntegrity(
    @Req() request: Request,
    @Param('id') _id: string,
    @Query() query: AcademyReportsQueryDto,
  ): Promise<AcademyIntegrityReportResponse> {
    const { academyId, organizationId, organizationPermissions } =
      request.academyContext!;
    return this.academyReportsService.getIntegrityReport(
      organizationId,
      academyId,
      request.authContext!.userId,
      organizationPermissions.includes(ORGANIZATION_DASHBOARD_PERMISSION),
      query.days,
    );
  }

  @Get('academies/:id/reports/sharing')
  @UseGuards(AcademyScopeGuard)
  async getSharing(
    @Req() request: Request,
    @Param('id') _id: string,
    @Query() query: AcademyReportsQueryDto,
  ): Promise<AcademySharingReportResponse> {
    const { academyId, organizationId, organizationPermissions } =
      request.academyContext!;
    return this.academyReportsService.getSharingReport(
      organizationId,
      academyId,
      request.authContext!.userId,
      organizationPermissions.includes(ORGANIZATION_DASHBOARD_PERMISSION),
      query.days,
    );
  }
}
