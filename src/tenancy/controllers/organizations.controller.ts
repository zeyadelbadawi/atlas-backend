/**
 * OrganizationsController — `/organizations/:id/*` (master plan §10). P2
 * implements only `GET /organizations/:id`; see the P2 final report for
 * why no create/update/delete/list endpoint exists this phase.
 */
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { OrganizationMembershipGuard } from '../guards/organization-membership.guard';
import { OrganizationsService } from '../services/organizations.service';
import type { OrganizationResponse } from '../dto/organization.contract';

@Controller('organizations')
@UseGuards(JwtAuthGuard, OrganizationMembershipGuard)
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Get(':id')
  async getById(@Param('id') id: string): Promise<OrganizationResponse> {
    return this.organizationsService.getById(id);
  }
}
