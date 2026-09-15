/**
 * Zoom Operations Center — Platform Owner only.
 *
 * GUARD DECIDES, RLS INDEPENDENTLY AGREES. `PlatformOwnerGuard` refuses
 * anyone who is not a platform owner before the service runs; the service
 * then reads inside `runInUserContext(platformOwnerId)`, where Postgres
 * re-evaluates `is_platform_owner` against the session variable for every
 * row. Neither layer trusts the other, and a tenant user who somehow
 * reached the service would still see nothing.
 *
 * A DISTINCT RESOURCE NAME, matching how `platform-academies` deliberately
 * differs from the tenant-scoped `academies`. Nothing here overlaps a
 * tenant route.
 *
 * NO WRITES. This is a monitoring and investigation surface; every
 * endpoint is a GET. Operational actions against a customer's connection
 * belong to the academy's own owner, not to an Atlas operator with a
 * button.
 */
import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { PlatformZoomService } from '../services/platform-zoom.service';
import {
  PlatformZoomConnectionsQueryDto,
  PlatformZoomSessionsQueryDto,
  PlatformZoomAttendanceQueryDto,
  PlatformZoomRecordingsQueryDto,
  PlatformZoomEventsQueryDto,
  PlatformZoomActivityQueryDto,
} from '../dto/platform-zoom-query.dto';
import type {
  ZoomConnectionRow,
  ZoomLiveSessionRow,
  ZoomOverviewResponse,
  ZoomAttendanceRow,
  ZoomRecordingRow,
  ZoomEventRow,
  ZoomEventHealth,
  ZoomHealthResponse,
  ZoomActivityRow,
  ZoomAcademyDetail,
} from '../dto/platform-zoom.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('platform-zoom')
@UseGuards(JwtAuthGuard, PlatformOwnerGuard)
export class PlatformZoomController {
  constructor(private readonly platformZoomService: PlatformZoomService) {}

  @Get('overview')
  async overview(@CurrentAuthContext() auth: AuthContext): Promise<ZoomOverviewResponse> {
    return this.platformZoomService.getOverview(auth.userId);
  }

  @Get('connections')
  async connections(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: PlatformZoomConnectionsQueryDto,
  ): Promise<PaginatedResult<ZoomConnectionRow>> {
    return this.platformZoomService.listConnections(auth.userId, query);
  }

  @Get('live-sessions')
  async sessions(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: PlatformZoomSessionsQueryDto,
  ): Promise<PaginatedResult<ZoomLiveSessionRow>> {
    return this.platformZoomService.listSessions(auth.userId, query);
  }

  @Get('attendance')
  async attendance(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: PlatformZoomAttendanceQueryDto,
  ): Promise<PaginatedResult<ZoomAttendanceRow>> {
    return this.platformZoomService.listAttendance(auth.userId, query);
  }

  @Get('recordings')
  async recordings(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: PlatformZoomRecordingsQueryDto,
  ): Promise<PaginatedResult<ZoomRecordingRow>> {
    return this.platformZoomService.listRecordings(auth.userId, query);
  }

  @Get('events')
  async events(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: PlatformZoomEventsQueryDto,
  ): Promise<PaginatedResult<ZoomEventRow> & { health: ZoomEventHealth }> {
    return this.platformZoomService.listEvents(auth.userId, query);
  }

  @Get('health')
  async health(@CurrentAuthContext() auth: AuthContext): Promise<ZoomHealthResponse> {
    return this.platformZoomService.getHealth(auth.userId);
  }

  @Get('activity')
  async activity(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: PlatformZoomActivityQueryDto,
  ): Promise<PaginatedResult<ZoomActivityRow>> {
    return this.platformZoomService.listActivity(auth.userId, query);
  }

  @Get('academies/:academyId')
  async academyDetail(
    @CurrentAuthContext() auth: AuthContext,
    @Param('academyId') academyId: string,
  ): Promise<ZoomAcademyDetail> {
    const detail = await this.platformZoomService.getAcademyDetail(auth.userId, academyId);
    if (!detail) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return detail;
  }
}
