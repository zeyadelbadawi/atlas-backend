/**
 * PlatformMetricsController — `platform-metrics` (master plan §21 Phase
 * P16), matching `PlatformMetricsService` (atlas frontend)'s singleton
 * resource exactly (`GET /platform-metrics`, no query params).
 */
import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { PlatformMetricsService } from '../services/platform-metrics.service';
import type { PlatformMetricsOverviewResponse } from '../dto/platform-metrics.contract';

@Controller('platform-metrics')
@UseGuards(JwtAuthGuard, PlatformOwnerGuard)
export class PlatformMetricsController {
  constructor(private readonly platformMetricsService: PlatformMetricsService) {}

  @Get()
  async getOverview(
    @CurrentAuthContext() auth: AuthContext,
  ): Promise<PlatformMetricsOverviewResponse> {
    return this.platformMetricsService.getOverview(auth.userId);
  }
}
