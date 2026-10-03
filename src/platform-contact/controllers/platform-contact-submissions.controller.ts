/**
 * PlatformContactSubmissionsController — `platform/contact-submissions/*`,
 * the Platform Owner's inbox for the Atlas marketing contact form.
 *
 * Every route carries the full Platform Owner stack: `JwtAuthGuard`
 * (a real session), `ManagementSurfaceGuard` (minted on the management
 * surface — an academy-website session is refused whatever its owner is)
 * and `PlatformOwnerGuard` (re-reads `is_platform_owner` per request).
 * RLS enforces the same rule underneath (`PlatformContactSubmissionsService`).
 *
 * DELETE is explicit and permanent; the UI confirms it first. Archive is
 * the reversible way to clear the inbox.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { PlatformContactSubmissionsService } from '../services/platform-contact-submissions.service';
import { ListPlatformContactSubmissionsQueryDto } from '../dto/list-platform-contact-submissions-query.dto';
import { UpdatePlatformContactSubmissionStatusDto } from '../dto/update-platform-contact-submission-status.dto';
import type {
  PlatformContactSubmissionResponse,
  PlatformContactSubmissionSummaryResponse,
} from '../dto/platform-contact-submission.contract';

@Controller('platform/contact-submissions')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, PlatformOwnerGuard)
export class PlatformContactSubmissionsController {
  constructor(private readonly service: PlatformContactSubmissionsService) {}

  @Get()
  async list(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: ListPlatformContactSubmissionsQueryDto,
  ): Promise<PaginatedResult<PlatformContactSubmissionResponse>> {
    return this.service.list(auth.userId, query);
  }

  /** Counts per status, independent of the list's filters. Declared before `:id`. */
  @Get('summary')
  async summary(
    @CurrentAuthContext() auth: AuthContext,
  ): Promise<PlatformContactSubmissionSummaryResponse> {
    return this.service.summary(auth.userId);
  }

  @Get(':id')
  async getById(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<PlatformContactSubmissionResponse> {
    return this.service.getById(auth.userId, id);
  }

  @Patch(':id')
  async updateStatus(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id') id: string,
    @Body() payload: UpdatePlatformContactSubmissionStatusDto,
  ): Promise<PlatformContactSubmissionResponse> {
    return this.service.updateStatus(auth.userId, id, payload);
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<void> {
    await this.service.delete(auth.userId, id);
  }
}
