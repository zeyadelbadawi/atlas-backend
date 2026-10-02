/**
 * `platform-observability/*` — the Platform Owner Observability Center.
 *
 * Platform Owner only, enforced server-side on every route by
 * `PlatformOwnerGuard` (re-reads `users.is_platform_owner` per request);
 * `ManagementSurfaceGuard` keeps learner sessions out entirely. Every path
 * parameter and query value is validated before it can reach a Prometheus
 * query: metric ids come from a fixed catalog, rule names must be
 * identifiers and must exist in Prometheus' own rule set.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import { ObservabilityService } from './observability.service';
import { WebVitalsService, type WebVitalsResponse } from './web-vitals.service';
import {
  AlertsQueryDto,
  ArmSyntheticAlertDto,
  RangeQueryDto,
  WebVitalsQueryDto,
} from './observability.dto';
import { ParseRuleNamePipe, ParseMetricIdPipe } from './observability.pipes';
import type {
  AlertRuleDetailResponse,
  AlertsResponse,
  MetricCatalogResponse,
  MetricSeriesResponse,
  MonitoringConfigurationResponse,
  SyntheticAlertState,
  SystemHealthResponse,
} from './observability.contract';

@Controller('platform-observability')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, PlatformOwnerGuard)
export class ObservabilityController {
  constructor(
    private readonly observability: ObservabilityService,
    private readonly webVitals: WebVitalsService,
  ) {}

  /** P6 — real-user Core Web Vitals, p75 by route template and device class. */
  @Get('web-vitals')
  webVitalsSummary(@Query() query: WebVitalsQueryDto): Promise<WebVitalsResponse> {
    return this.webVitals.aggregate(query.range ?? '7d');
  }

  @Get('health')
  health(@CurrentAuthContext() auth: AuthContext): Promise<SystemHealthResponse> {
    return this.observability.health(auth.userId);
  }

  @Get('alerts')
  alerts(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: AlertsQueryDto,
  ): Promise<AlertsResponse> {
    return this.observability.alerts(auth.userId, {
      status: query.status ?? 'all',
      severity: query.severity,
      rule: query.rule,
      range: query.range ?? '24h',
    });
  }

  @Get('alerts/rules/:ruleName')
  rule(
    @CurrentAuthContext() auth: AuthContext,
    @Param('ruleName', ParseRuleNamePipe) ruleName: string,
    @Query() query: RangeQueryDto,
  ): Promise<AlertRuleDetailResponse> {
    return this.observability.ruleDetail(auth.userId, ruleName, query.range ?? '24h');
  }

  @Get('metrics')
  metricCatalog(): Promise<MetricCatalogResponse> {
    return this.observability.metricCatalog();
  }

  @Get('metrics/:metricId')
  metric(
    @Param('metricId', ParseMetricIdPipe) metricId: string,
    @Query() query: RangeQueryDto,
  ): Promise<MetricSeriesResponse> {
    return this.observability.metricSeries(metricId, query.range ?? '24h');
  }

  @Get('configuration')
  configuration(): Promise<MonitoringConfigurationResponse> {
    return this.observability.configuration();
  }

  @Post('synthetic-alert')
  @HttpCode(HttpStatus.OK)
  arm(
    @CurrentAuthContext() auth: AuthContext,
    @Body() body: ArmSyntheticAlertDto,
  ): Promise<SyntheticAlertState> {
    return this.observability.armSynthetic(auth.userId, body.minutes);
  }

  @Delete('synthetic-alert')
  disarm(@CurrentAuthContext() auth: AuthContext): Promise<SyntheticAlertState> {
    return this.observability.disarmSynthetic(auth.userId);
  }
}
