/**
 * OrganizationsController — `organizations`/`organizations/:id` (master
 * plan §10). Originally P2's own controller (`GET /organizations/:id`
 * only); moved here in Phase P15 and additively given `GET /organizations`
 * (list) — see `TenancyModule`'s own doc comment for exactly why the move
 * was necessary (a real, confirmed cross-phase route collision, not a
 * redesign), and `OrganizationsAccessGuard`'s own doc comment for the
 * full account of both real audiences this now serves.
 *
 * `getById` calls the SAME, UNMODIFIED `OrganizationsService.getById`
 * (P2) for every non-Platform-Owner caller — byte-for-byte the same
 * response shape/behavior as before this phase.
 */
import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { OrganizationsAccessGuard } from '../guards/organizations-access.guard';
import { OrganizationsService } from '../../tenancy/services/organizations.service';
import { PlatformOrganizationsService } from '../services/platform-organizations.service';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type { OrganizationResponse } from '../../tenancy/dto/organization.contract';
import type {
  PlatformOrganizationDetailResponse,
  PlatformOrganizationSummaryResponse,
} from '../dto/platform-organization.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('organizations')
@UseGuards(JwtAuthGuard, OrganizationsAccessGuard)
export class OrganizationsController {
  constructor(
    private readonly organizationsService: OrganizationsService,
    private readonly platformOrganizationsService: PlatformOrganizationsService,
  ) {}

  /** Platform-Owner-only — `OrganizationsAccessGuard` already refused any other caller before this method is ever reached. */
  @Get()
  async list(
    @Req() request: Request,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<PlatformOrganizationSummaryResponse>> {
    return this.platformOrganizationsService.listOrganizations(
      request.authContext!.userId,
      query,
    );
  }

  @Get(':id')
  async getById(
    @Req() request: Request,
    @Param('id') id: string,
  ): Promise<OrganizationResponse | PlatformOrganizationDetailResponse> {
    if (request.isPlatformOwnerCaller) {
      return this.platformOrganizationsService.getOrganization(
        request.authContext!.userId,
        id,
      );
    }
    return this.organizationsService.getById(id);
  }
}
