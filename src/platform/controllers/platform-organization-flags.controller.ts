/**
 * B0-ANL-04 — `GET/PATCH /platform-organizations/:organizationId/flags`.
 *
 * Platform Owner only (`PlatformOwnerGuard` re-reads `is_platform_owner`
 * from the database), and the table's RLS admits nobody else either. One
 * hyphenated resource segment, like every sibling Platform Owner surface.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { PlatformOrganizationFlagsService } from '../services/platform-organization-flags.service';
import {
  UpdateOrganizationPlatformFlagsDto,
  type OrganizationPlatformFlagsResponse,
} from '../dto/organization-platform-flags.dto';

@Controller('platform-organizations')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, PlatformOwnerGuard)
export class PlatformOrganizationFlagsController {
  constructor(private readonly flagsService: PlatformOrganizationFlagsService) {}

  @Get(':organizationId/flags')
  async get(
    @CurrentAuthContext() auth: AuthContext,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ): Promise<OrganizationPlatformFlagsResponse> {
    return this.flagsService.get(auth.userId, organizationId);
  }

  @Patch(':organizationId/flags')
  async update(
    @CurrentAuthContext() auth: AuthContext,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: UpdateOrganizationPlatformFlagsDto,
  ): Promise<OrganizationPlatformFlagsResponse> {
    return this.flagsService.setInternal(auth.userId, organizationId, body.isInternal);
  }
}
