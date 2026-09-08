/**
 * TenantSupportCasesController — Phase 8's tenant-facing counterpart to
 * `SupportCasesController` (which stays exactly as it was: Platform-Owner
 * only, no create route — see its own doc comment). This controller adds
 * the create-a-ticket / track-my-tickets surface the roadmap calls for,
 * mounted under the SAME route-scoping convention every other tenant
 * write in this codebase already uses (`organizations/:id/...`/
 * `academies/:id/...`, reusing `OrganizationMembershipGuard`/
 * `AcademyScopeGuard` verbatim) rather than a bare `support-cases` path —
 * that bare path is already owned by the Platform-Owner-only controller,
 * and every other tenant-scoped resource in this backend is mounted this
 * same way (`organizations/:id/provisioning-requests`, `academies/:id/
 * members`, ...), so this follows the existing convention instead of
 * inventing a second one.
 *
 * Two parallel route groups, not one: an Organization Owner's ticket has
 * no single Academy (`academyId: null`); an Academy Manager's ticket is
 * scoped to the one Academy they manage. Both funnel into the same
 * `SupportCasesService.createCase`/`listMyCases`, which is what actually
 * enforces "you may only ever see/create your own ticket" via the real,
 * independent RLS policies those methods run under — this controller's
 * job is only resolving `organizationId`/`academyId`/`role` from whichever
 * guard ran, never a second authorization decision of its own.
 */
import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { OrganizationMembershipGuard } from '../../tenancy/guards/organization-membership.guard';
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { SupportCasesService } from '../services/support-cases.service';
import { CreateSupportCaseDto } from '../dto/create-support-case.dto';
import { ListSupportCasesQueryDto } from '../dto/list-support-cases-query.dto';
import type {
  SupportCaseDetailResponse,
  SupportCaseSummaryResponse,
} from '../dto/support-case.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller()
@UseGuards(JwtAuthGuard)
export class TenantSupportCasesController {
  constructor(private readonly supportCasesService: SupportCasesService) {}

  @Post('organizations/:id/support-cases')
  @UseGuards(OrganizationMembershipGuard)
  async createForOrganization(
    @Req() request: Request,
    @Body() body: CreateSupportCaseDto,
  ): Promise<SupportCaseDetailResponse> {
    const { organizationId, role } = request.tenantContext!;
    return this.supportCasesService.createCase(
      organizationId,
      request.authContext!.userId,
      null,
      role,
      body,
    );
  }

  @Get('organizations/:id/support-cases')
  @UseGuards(OrganizationMembershipGuard)
  async listMineForOrganization(
    @Req() request: Request,
    @Query() query: ListSupportCasesQueryDto,
  ): Promise<PaginatedResult<SupportCaseSummaryResponse>> {
    return this.supportCasesService.listMyCases(request.authContext!.userId, query);
  }

  @Post('academies/:id/support-cases')
  @UseGuards(AcademyScopeGuard)
  async createForAcademy(
    @Req() request: Request,
    @Body() body: CreateSupportCaseDto,
  ): Promise<SupportCaseDetailResponse> {
    const { academyId, organizationId, organizationRole } = request.academyContext!;
    return this.supportCasesService.createCase(
      organizationId,
      request.authContext!.userId,
      academyId,
      organizationRole,
      body,
    );
  }

  @Get('academies/:id/support-cases')
  @UseGuards(AcademyScopeGuard)
  async listMineForAcademy(
    @Req() request: Request,
    @Query() query: ListSupportCasesQueryDto,
  ): Promise<PaginatedResult<SupportCaseSummaryResponse>> {
    return this.supportCasesService.listMyCases(request.authContext!.userId, query);
  }
}
