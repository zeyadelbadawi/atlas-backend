/**
 * W3-compose — the Platform Owner's "Compose and send".
 *
 * The same guard trio as every platform-owner surface (authenticated, on
 * the management surface, actually a Platform Owner — re-read per request),
 * and the service then runs under the caller's own user context, so the
 * platform RLS policies prove it a second time.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../identity/guards/jwt-auth.guard';
import type { AuthContext } from '../../../identity/guards/jwt-auth.guard';
import { PlatformOwnerGuard } from '../../../identity/guards/platform-owner.guard';
import { ManagementSurfaceGuard } from '../../../tenancy/guards/management-surface.guard';
import { CurrentAuthContext } from '../../../identity/decorators/auth-context.decorator';
import { CommunicationCampaignService } from '../communication-campaign.service';
import {
  ListCampaignsQueryDto,
  PreviewCampaignDto,
  SendCampaignDto,
  parsePlatformAudience,
} from '../dto/campaign.dto';
import type {
  CampaignAcceptedResponse,
  CampaignPreviewResponse,
  CampaignSummaryResponse,
} from '../campaign.types';

@Controller('platform-communications/campaigns')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, PlatformOwnerGuard)
export class PlatformCampaignsController {
  constructor(private readonly campaigns: CommunicationCampaignService) {}

  /** Counts and exclusions for an audience. No side effects. */
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  async preview(
    @CurrentAuthContext() auth: AuthContext,
    @Body() body: PreviewCampaignDto,
  ): Promise<CampaignPreviewResponse> {
    return this.campaigns.preview(
      { scope: 'platform', actorUserId: auth.userId },
      { audience: parsePlatformAudience(body.audience), channels: body.channels },
    );
  }

  /** Accepts a campaign (202); delivery happens off the request path. */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async send(
    @CurrentAuthContext() auth: AuthContext,
    @Body() body: SendCampaignDto,
  ): Promise<CampaignAcceptedResponse> {
    return this.campaigns.send(
      { scope: 'platform', actorUserId: auth.userId },
      { ...body, audience: parsePlatformAudience(body.audience) },
    );
  }

  @Get()
  async list(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: ListCampaignsQueryDto,
  ): Promise<{ items: CampaignSummaryResponse[]; nextCursor: string | null }> {
    return this.campaigns.list(
      { scope: 'platform', actorUserId: auth.userId },
      { limit: query.limit ?? 20, cursor: query.cursor },
    );
  }

  @Get(':campaignId')
  async get(
    @CurrentAuthContext() auth: AuthContext,
    @Param('campaignId', new ParseUUIDPipe()) campaignId: string,
  ): Promise<CampaignSummaryResponse> {
    return this.campaigns.get(
      { scope: 'platform', actorUserId: auth.userId },
      campaignId,
    );
  }
}
