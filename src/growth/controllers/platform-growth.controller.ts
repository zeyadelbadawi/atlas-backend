/**
 * PlatformGrowthController — G1: `platform-growth/*`, the Platform Owner's
 * season capacity plan and CAC per channel. Guards exactly like
 * `PlatformLaunchChecklistController` (401 without a session, 403 for
 * anyone but a Platform Owner); RLS is the second line (Platform Owner
 * only, reads included). Every response is `private, no-store` (the app
 * default, `common/http/cache-policy.ts`; no handler here overrides it).
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import {
  CreateSpendEntryDto,
  MonthRangeQueryDto,
  SetOrganizationChannelDto,
  UpdateGrowthSettingsDto,
  UpdateSpendEntryDto,
} from '../dto/growth.dto';
import type {
  CacReportResponse,
  CapacityReportResponse,
  GrowthSettingsResponse,
  OrganizationAcquisitionResponse,
  SpendEntryResponse,
  SpendListResponse,
} from '../dto/growth.contract';
import { GrowthSettingsService } from '../services/growth-settings.service';
import { MarketingSpendService } from '../services/marketing-spend.service';
import { GrowthReportsService } from '../services/growth-reports.service';
import { OrganizationAcquisitionService } from '../services/organization-acquisition.service';

function actor(request: Request): string {
  return request.authContext!.userId;
}

@Controller('platform-growth')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, PlatformOwnerGuard)
export class PlatformGrowthController {
  constructor(
    private readonly settings: GrowthSettingsService,
    private readonly spend: MarketingSpendService,
    private readonly reports: GrowthReportsService,
    private readonly acquisition: OrganizationAcquisitionService,
  ) {}

  @Get('settings')
  getSettings(@Req() request: Request): Promise<GrowthSettingsResponse> {
    return this.settings.get(actor(request));
  }

  @Patch('settings')
  updateSettings(
    @Req() request: Request,
    @Body() body: UpdateGrowthSettingsDto,
  ): Promise<GrowthSettingsResponse> {
    return this.settings.update(actor(request), body);
  }

  @Get('spend')
  listSpend(
    @Req() request: Request,
    @Query() query: MonthRangeQueryDto,
  ): Promise<SpendListResponse> {
    return this.spend.list(actor(request), query);
  }

  @Post('spend')
  createSpend(
    @Req() request: Request,
    @Body() body: CreateSpendEntryDto,
  ): Promise<SpendEntryResponse> {
    return this.spend.create(actor(request), body);
  }

  @Patch('spend/:id')
  updateSpend(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateSpendEntryDto,
  ): Promise<SpendEntryResponse> {
    return this.spend.update(actor(request), id, body);
  }

  @Delete('spend/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeSpend(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.spend.remove(actor(request), id);
  }

  @Get('cac')
  cac(
    @Req() request: Request,
    @Query() query: MonthRangeQueryDto,
  ): Promise<CacReportResponse> {
    return this.reports.cac(actor(request), query);
  }

  @Get('capacity')
  capacity(@Req() request: Request): Promise<CapacityReportResponse> {
    return this.reports.capacity(actor(request));
  }

  @Patch('organizations/:id/channel')
  setOrganizationChannel(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SetOrganizationChannelDto,
  ): Promise<OrganizationAcquisitionResponse> {
    return this.acquisition.setChannel(actor(request), id, body);
  }
}
