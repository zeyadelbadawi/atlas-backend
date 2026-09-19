/**
 * Add-ons Management — Platform Owner only.
 *
 * GUARD DECIDES, RLS INDEPENDENTLY AGREES. `PlatformOwnerGuard` refuses a
 * tenant user with 403 and `JwtAuthGuard` refuses an anonymous caller with
 * 401 before the service runs; the count aggregation then reads inside
 * `runInUserContext(platformOwnerId)`, where Postgres re-checks
 * `is_platform_owner` for every `tenant_add_ons` row. Neither layer trusts
 * the other.
 *
 * A DISTINCT RESOURCE NAME (`platform-add-ons`), matching how every other
 * Platform surface (`platform-zoom`, `platform-settings`) deliberately
 * differs from its tenant-scoped cousin (`add-ons`). Nothing here overlaps
 * a tenant route: this controls the CATALOG publication state, the tenant
 * route installs/enables per academy.
 */
import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { PlatformAddOnsService } from '../services/platform-add-ons.service';
import { PlatformAddOnQueryDto } from '../dto/platform-add-on-query.dto';
import { UpdateAddOnCatalogStatusDto } from '../dto/update-add-on-catalog-status.dto';
import type {
  PlatformAddOnListResponse,
  PlatformAddOnRow,
} from '../dto/platform-add-on.contract';

@Controller('platform-add-ons')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, PlatformOwnerGuard)
export class PlatformAddOnsController {
  constructor(private readonly platformAddOnsService: PlatformAddOnsService) {}

  @Get()
  async list(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: PlatformAddOnQueryDto,
  ): Promise<PlatformAddOnListResponse> {
    return this.platformAddOnsService.list(auth.userId, query);
  }

  @Patch(':key/status')
  async updateStatus(
    @CurrentAuthContext() auth: AuthContext,
    @Param('key') key: string,
    @Body() payload: UpdateAddOnCatalogStatusDto,
  ): Promise<PlatformAddOnRow> {
    return this.platformAddOnsService.updateCatalogStatus(auth.userId, key, payload);
  }
}
