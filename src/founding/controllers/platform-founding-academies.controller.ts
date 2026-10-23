/**
 * PlatformFoundingAcademiesController — B2: `platform-founding-academies`,
 * the Platform Owner's Founding Academies management.
 *
 * One hyphenated segment like every sibling Platform Owner surface (see
 * `AdminSubscriptionsController`). AUTHORIZATION: `PlatformOwnerGuard`
 * re-reads the caller's real `is_platform_owner` column on every request
 * (and the session's Platform Owner sign-in rules, 2FA included, already
 * applied at sign-in); `ManagementSurfaceGuard` refuses academy-website
 * sessions. The table's RLS is the second line: writes need a Platform
 * Owner user context whatever the route.
 */
import {
  Body,
  Controller,
  Get,
  Header,
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
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { FoundingMembershipsService } from '../services/founding-memberships.service';
import {
  CreateFoundingMembershipDto,
  FoundingCandidatesQueryDto,
  FoundingEmailAudienceDto,
  FoundingQuoteQueryDto,
  ListFoundingMembershipsQueryDto,
  RevokeFoundingMembershipDto,
  SendFoundingEmailDto,
  UpdateFoundingMembershipDto,
} from '../dto/founding.dto';
import type {
  FoundingCandidate,
  FoundingEligiblePlan,
  FoundingEmailPreview,
  FoundingEmailSendResult,
  FoundingMembershipDetail,
  FoundingMembershipSummary,
  FoundingQuote,
  FoundingSeatSummary,
} from '../dto/founding.contract';

@Controller('platform-founding-academies')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, PlatformOwnerGuard)
export class PlatformFoundingAcademiesController {
  constructor(private readonly service: FoundingMembershipsService) {}

  private actor(request: Request): string {
    return request.authContext!.userId;
  }

  @Get()
  list(
    @Req() request: Request,
    @Query() query: ListFoundingMembershipsQueryDto,
  ): Promise<PaginatedResult<FoundingMembershipSummary>> {
    return this.service.list(this.actor(request), query);
  }

  @Get('summary')
  summary(@Req() request: Request): Promise<FoundingSeatSummary> {
    return this.service.summary(this.actor(request));
  }

  @Get('plans')
  plans(@Req() request: Request): Promise<FoundingEligiblePlan[]> {
    return this.service.eligiblePlans(this.actor(request));
  }

  @Get('candidates')
  candidates(
    @Req() request: Request,
    @Query() query: FoundingCandidatesQueryDto,
  ): Promise<FoundingCandidate[]> {
    return this.service.candidates(this.actor(request), query.search);
  }

  @Get('quote')
  quote(
    @Req() request: Request,
    @Query() query: FoundingQuoteQueryDto,
  ): Promise<FoundingQuote> {
    return this.service.quote(this.actor(request), query.organizationId, query.planKey);
  }

  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="founding-academies.csv"')
  @Header('Cache-Control', 'no-store')
  exportCsv(@Req() request: Request): Promise<string> {
    return this.service.exportCsv(this.actor(request));
  }

  @Post('email/preview')
  @HttpCode(HttpStatus.OK)
  previewEmail(
    @Req() request: Request,
    @Body() body: FoundingEmailAudienceDto,
  ): Promise<FoundingEmailPreview> {
    return this.service.previewEmail(this.actor(request), body);
  }

  @Post('email')
  @HttpCode(HttpStatus.ACCEPTED)
  sendEmail(
    @Req() request: Request,
    @Body() body: SendFoundingEmailDto,
  ): Promise<FoundingEmailSendResult> {
    return this.service.sendEmail(this.actor(request), body);
  }

  @Get(':id')
  get(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FoundingMembershipDetail> {
    return this.service.get(this.actor(request), id);
  }

  @Post()
  create(
    @Req() request: Request,
    @Body() body: CreateFoundingMembershipDto,
  ): Promise<FoundingMembershipDetail> {
    return this.service.create(this.actor(request), body);
  }

  @Patch(':id')
  update(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateFoundingMembershipDto,
  ): Promise<FoundingMembershipDetail> {
    return this.service.update(this.actor(request), id, body);
  }

  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  revoke(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RevokeFoundingMembershipDto,
  ): Promise<FoundingMembershipDetail> {
    return this.service.revoke(this.actor(request), id, body);
  }
}
