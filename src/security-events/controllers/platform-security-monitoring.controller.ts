/**
 * PlatformSecurityMonitoringController — W3: the Platform Owner's "OTP &
 * Security Monitoring" page (sidebar: Email & Notifications).
 *
 * Platform Owner only, on a management session — the guard trio every
 * platform-owner surface uses — and re-proven by RLS under the caller's own
 * context (`security_events_platform_select` is the table's ONLY SELECT
 * policy). Pre-auth events (unknown accounts, sign-in floods) are therefore
 * visible to nobody else at all. Read-only, so nothing here is audited.
 */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { SecurityMonitoringQueryService } from '../services/security-monitoring-query.service';
import { SecurityMonitoringQueryDto } from '../dto/security-monitoring.dto';
import type {
  SecurityEventPage,
  SecurityMonitoringSummary,
} from '../dto/security-monitoring.contract';

@Controller('platform-security')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, PlatformOwnerGuard)
export class PlatformSecurityMonitoringController {
  constructor(private readonly monitoring: SecurityMonitoringQueryService) {}

  /** Totals, verify rate and a per-day series for the trailing window. */
  @Get('summary')
  async summary(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: SecurityMonitoringQueryDto,
  ): Promise<SecurityMonitoringSummary> {
    return this.monitoring.summary(auth.userId, query);
  }

  /** Recent events, newest first, masked; keyset-paginated. */
  @Get('events')
  async events(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: SecurityMonitoringQueryDto,
  ): Promise<SecurityEventPage> {
    return this.monitoring.events(auth.userId, query);
  }
}
