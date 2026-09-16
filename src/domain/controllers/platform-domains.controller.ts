/**
 * PlatformDomainsController — `platform-domains` (P63). A flat hyphenated
 * resource (never a slashed one — `BaseService.resourcePath()` on the
 * frontend percent-encodes every segment). Platform Owner only, through
 * the same guard pair every other `platform-*` console uses.
 */
import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { PlatformDomainsService } from '../services/platform-domains.service';
import { PlatformDomainsQueryDto } from '../dto/platform-domains-query.dto';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import type {
  PlatformDomainRowResponse,
  PlatformDomainsOverviewResponse,
} from '../dto/platform-domains.contract';

@Controller('platform-domains')
@UseGuards(JwtAuthGuard, PlatformOwnerGuard)
export class PlatformDomainsController {
  constructor(private readonly platformDomainsService: PlatformDomainsService) {}

  @Get()
  async list(
    @Req() request: Request,
    @Query() query: PlatformDomainsQueryDto,
  ): Promise<PaginatedResult<PlatformDomainRowResponse>> {
    return this.platformDomainsService.list(request.authContext!.userId, query);
  }

  @Get('overview')
  async overview(@Req() request: Request): Promise<PlatformDomainsOverviewResponse> {
    return this.platformDomainsService.overview(request.authContext!.userId);
  }

  @Get(':academyId')
  async get(
    @Req() request: Request,
    @Param('academyId') academyId: string,
  ): Promise<PlatformDomainRowResponse> {
    return this.platformDomainsService.get(request.authContext!.userId, academyId);
  }

  @Post(':academyId/check')
  @HttpCode(200)
  async check(
    @Req() request: Request,
    @Param('academyId') academyId: string,
  ): Promise<PlatformDomainRowResponse> {
    return this.platformDomainsService.check(request.authContext!.userId, academyId);
  }
}
