/**
 * DashboardSiteAnnouncementsController — B3: `site-announcements/dashboard`,
 * the banner every signed-in dashboard user sees (Platform Owners, owners,
 * staff; learners are refused by `ManagementSurfaceGuard`).
 *
 * Filtered by the announcement's audience from the caller's real facts
 * (`PrincipalResolverService`, already resolved by the guard on this
 * request): organization owners, academy staff (owner, administrator,
 * manager or instructor of an academy, or an organization owner), or
 * everybody. Per-user, so the default `private, no-store` stands.
 */
import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { PrincipalResolverService } from '../../tenancy/services/principal-resolver.service';
import { SiteAnnouncementsService } from '../services/site-announcements.service';
import { DashboardSiteAnnouncementsQueryDto } from '../dto/site-announcements.dto';
import type { DashboardAnnouncements } from '../dto/site-announcements.contract';

@Controller('site-announcements')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard)
export class DashboardSiteAnnouncementsController {
  constructor(
    private readonly service: SiteAnnouncementsService,
    private readonly principals: PrincipalResolverService,
  ) {}

  @Get('dashboard')
  async dashboard(
    @Req() request: Request,
    @Query() query: DashboardSiteAnnouncementsQueryDto,
  ): Promise<DashboardAnnouncements> {
    const principal = await this.principals.forRequest(
      request,
      request.authContext!.userId,
    );
    return this.service.dashboard(principal, query.locale ?? 'en');
  }
}
