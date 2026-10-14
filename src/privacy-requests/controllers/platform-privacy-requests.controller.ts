/**
 * B0-SEC-13 — `platform-privacy-requests`: the Platform Owner's queue.
 *
 * Flat hyphenated resource (see `PlatformUserManagementController` for why a
 * slashed `platform/...` path breaks the frontend's `BaseService`).
 * `PlatformOwnerGuard` re-reads `users.is_platform_owner` on every request;
 * the RLS policies on `privacy_requests` admit Platform Owners only.
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
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { ListPrivacyRequestsQueryDto } from '../dto/list-privacy-requests-query.dto';
import { UpdatePrivacyRequestStatusDto } from '../dto/update-privacy-request-status.dto';
import { FulfilPrivacyRequestDto } from '../dto/fulfil-privacy-request.dto';
import type { PlatformPrivacyRequestResponse } from '../dto/privacy-request.contract';
import { PlatformPrivacyRequestsService } from '../services/platform-privacy-requests.service';

@Controller('platform-privacy-requests')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, PlatformOwnerGuard)
export class PlatformPrivacyRequestsController {
  constructor(private readonly service: PlatformPrivacyRequestsService) {}

  @Get()
  list(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: ListPrivacyRequestsQueryDto,
  ): Promise<PaginatedResult<PlatformPrivacyRequestResponse>> {
    return this.service.list(auth.userId, query);
  }

  @Get(':id')
  get(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<PlatformPrivacyRequestResponse> {
    return this.service.get(auth.userId, id);
  }

  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  updateStatus(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdatePrivacyRequestStatusDto,
  ): Promise<PlatformPrivacyRequestResponse> {
    return this.service.updateStatus(auth.userId, id, dto);
  }

  /**
   * Export: opens the download window and emails the person. Deletion:
   * deletes the account through the existing Platform Owner path. `confirm`
   * must be `true` (the DTO enforces it).
   */
  @Post(':id/fulfil')
  @HttpCode(HttpStatus.OK)
  fulfil(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() _dto: FulfilPrivacyRequestDto,
  ): Promise<PlatformPrivacyRequestResponse> {
    return this.service.fulfil(auth.userId, id);
  }
}
