/**
 * AnalyticsController — `analytics` (master plan §21 Phase P16), matching
 * `AnalyticsService` (atlas frontend)'s three read routes exactly:
 * `GET /analytics/overview`, `GET /analytics/time-series/:metric`,
 * `GET /analytics/breakdown/:dimension` (`resourcePath('analytics',
 * 'time-series', metric)` / `'breakdown', dimension`), each accepting the
 * flattened `from`/`to` query params `AnalyticsService.toParams` sends.
 */
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { AnalyticsService } from '../services/analytics.service';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import type {
  AnalyticsOverviewResponse,
  AnalyticsTimeSeriesResponse,
  AnalyticsBreakdownResponse,
} from '../dto/analytics.contract';

@Controller('analytics')
@UseGuards(JwtAuthGuard, PlatformOwnerGuard)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('overview')
  async getOverview(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: AnalyticsQueryDto,
  ): Promise<AnalyticsOverviewResponse> {
    return this.analyticsService.getOverview(auth.userId, query.from, query.to);
  }

  @Get('time-series/:metric')
  async getTimeSeries(
    @CurrentAuthContext() auth: AuthContext,
    @Param('metric') metric: string,
    @Query() query: AnalyticsQueryDto,
  ): Promise<AnalyticsTimeSeriesResponse> {
    return this.analyticsService.getTimeSeries(auth.userId, metric, query.from, query.to);
  }

  @Get('breakdown/:dimension')
  async getBreakdown(
    @CurrentAuthContext() auth: AuthContext,
    @Param('dimension') dimension: string,
    @Query() query: AnalyticsQueryDto,
  ): Promise<AnalyticsBreakdownResponse> {
    return this.analyticsService.getBreakdown(
      auth.userId,
      dimension,
      query.from,
      query.to,
    );
  }
}
