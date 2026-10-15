/**
 * PlatformMetricsController — `platform-metrics` (master plan §21 Phase
 * P16), matching `PlatformMetricsService` (atlas frontend)'s singleton
 * resource exactly (`GET /platform-metrics`, no query params).
 */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { PlatformMetricsService } from '../services/platform-metrics.service';
import type { PlatformMetricsOverviewResponse } from '../dto/platform-metrics.contract';
import type { PlatformVideoMetricsResponse } from '../dto/platform-video-metrics.contract';
import type { PlatformCommerceMetricsResponse } from '../dto/platform-commerce-metrics.contract';
import type { PlatformDeliveryMetricsResponse } from '../dto/platform-delivery-metrics.contract';
import {
  GROWTH_WEEKS_DEFAULT,
  PlatformGrowthQueryDto,
  PlatformMetricsWindowQueryDto,
  REPORT_WINDOW_DEFAULT_DAYS,
} from '../dto/platform-metrics-query.dto';
import type { PlatformGrowthMetricsResponse } from '../dto/platform-growth-metrics.contract';

@Controller('platform-metrics')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, PlatformOwnerGuard)
export class PlatformMetricsController {
  constructor(private readonly platformMetricsService: PlatformMetricsService) {}

  @Get()
  async getOverview(
    @CurrentAuthContext() auth: AuthContext,
  ): Promise<PlatformMetricsOverviewResponse> {
    return this.platformMetricsService.getOverview(auth.userId);
  }

  /** P64 Phase 4 §E.5 — video minutes / provider health. Same three guards as the overview. */
  @Get('video')
  async getVideo(
    @CurrentAuthContext() auth: AuthContext,
  ): Promise<PlatformVideoMetricsResponse> {
    return this.platformMetricsService.getVideoOverview(auth.userId);
  }

  /** P64 Phase 4 §E.5 — checkout / approval / refund counts for the trailing `days` (1–90, default 30). Same three guards. */
  @Get('commerce')
  async getCommerce(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: PlatformMetricsWindowQueryDto,
  ): Promise<PlatformCommerceMetricsResponse> {
    return this.platformMetricsService.getCommerceOverview(
      auth.userId,
      query.days ?? REPORT_WINDOW_DEFAULT_DAYS,
    );
  }

  /** B0-ANL-04 (part 3) — weekly activation funnel by signup cohort (1–26 weeks, default 12), internal organizations excluded. Same three guards. */
  @Get('growth')
  async getGrowth(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: PlatformGrowthQueryDto,
  ): Promise<PlatformGrowthMetricsResponse> {
    return this.platformMetricsService.getGrowthOverview(
      auth.userId,
      query.weeks ?? GROWTH_WEEKS_DEFAULT,
    );
  }

  /** P64 Phase 4 §E.5 — access decisions, video inventory and retention backlog for the trailing `days` (1–90, default 30). Same three guards. */
  @Get('delivery')
  async getDelivery(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: PlatformMetricsWindowQueryDto,
  ): Promise<PlatformDeliveryMetricsResponse> {
    return this.platformMetricsService.getDeliveryOverview(
      auth.userId,
      query.days ?? REPORT_WINDOW_DEFAULT_DAYS,
    );
  }
}
