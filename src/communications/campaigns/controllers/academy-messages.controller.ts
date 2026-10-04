/**
 * W3-compose — an academy's "Messages" (W3b B.4).
 *
 * `AcademyScopeGuard` proves only that the caller belongs to the academy's
 * organization (or holds an active academy membership). Every handler then
 * calls `assertAcademySender`, which requires an ACTIVE `academy_members`
 * row with role owner or administrator on an ACTIVE academy — so a
 * manager, instructor, staff member, learner or another academy's owner is
 * refused with 403 whatever their organization role. The expired-tenant
 * write block (`SubscriptionAccessInterceptor`) applies as on every other
 * `/academies/:id` mutation.
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
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../../tenancy/guards/management-surface.guard';
import { AcademyScopeGuard } from '../../../academy/guards/academy-scope.guard';
import { CommunicationCampaignService } from '../communication-campaign.service';
import {
  ListCampaignsQueryDto,
  PreviewCampaignDto,
  SendCampaignDto,
  parseAcademyAudience,
} from '../dto/campaign.dto';
import type {
  CampaignAcceptedResponse,
  CampaignPreviewResponse,
  CampaignQuotaView,
  CampaignSummaryResponse,
} from '../campaign.types';

@Controller('academies/:id/messages')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, AcademyScopeGuard)
export class AcademyMessagesController {
  constructor(private readonly campaigns: CommunicationCampaignService) {}

  private sender(request: Request, academyId: string) {
    return this.campaigns.assertAcademySender(
      academyId,
      request.academyContext!.organizationId,
      request.authContext!.userId,
    );
  }

  /** "23 of 50 emails used this month, resets 1 Nov." */
  @Get('quota')
  async quota(
    @Req() request: Request,
    @Param('id', new ParseUUIDPipe()) academyId: string,
  ): Promise<CampaignQuotaView> {
    return this.campaigns.quotaView(await this.sender(request, academyId));
  }

  /** Recipient counts, exclusions and quota remaining. Charges nothing. */
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  async preview(
    @Req() request: Request,
    @Param('id', new ParseUUIDPipe()) academyId: string,
    @Body() body: PreviewCampaignDto,
  ): Promise<CampaignPreviewResponse> {
    const sender = await this.sender(request, academyId);
    return this.campaigns.preview(sender, {
      audience: parseAcademyAudience(body.audience),
      channels: body.channels,
    });
  }

  /**
   * 202 with the message id; 422 `ACADEMY_EMAIL_QUOTA_EXCEEDED` (with the
   * remaining count) when the emails do not fit; 409
   * `CAMPAIGN_AUDIENCE_CHANGED` when the audience moved since the preview.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async send(
    @Req() request: Request,
    @Param('id', new ParseUUIDPipe()) academyId: string,
    @Body() body: SendCampaignDto,
  ): Promise<CampaignAcceptedResponse> {
    const sender = await this.sender(request, academyId);
    return this.campaigns.send(sender, {
      ...body,
      audience: parseAcademyAudience(body.audience),
    });
  }

  @Get()
  async list(
    @Req() request: Request,
    @Param('id', new ParseUUIDPipe()) academyId: string,
    @Query() query: ListCampaignsQueryDto,
  ): Promise<{ items: CampaignSummaryResponse[]; nextCursor: string | null }> {
    const sender = await this.sender(request, academyId);
    return this.campaigns.list(sender, {
      limit: query.limit ?? 20,
      cursor: query.cursor,
    });
  }

  @Get(':messageId')
  async get(
    @Req() request: Request,
    @Param('id', new ParseUUIDPipe()) academyId: string,
    @Param('messageId', new ParseUUIDPipe()) messageId: string,
  ): Promise<CampaignSummaryResponse> {
    const sender = await this.sender(request, academyId);
    return this.campaigns.get(sender, messageId);
  }
}
