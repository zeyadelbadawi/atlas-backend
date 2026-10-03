/**
 * AuditLogController — `audit-log`/`audit-log/:id` (master plan §21
 * Phase P15), matching `AuditLogService` (atlas frontend)'s flat,
 * cross-tenant `resource = 'audit-log'` exactly. Read-only — there is no
 * frontend write path (the backend is the sole writer, see
 * `AuditLogWriterService`).
 */
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { AuditLogService } from '../services/audit-log.service';
import { ListAuditLogQueryDto } from '../dto/list-audit-log-query.dto';
import { PlatformAuditFeedQueryDto } from '../../audit-log/dto/audit-feed-query.dto';
import type {
  AuditLogCursorPage,
  AuditLogEntryDetailResponse,
  AuditLogEntrySummaryResponse,
} from '../../audit-log/dto/audit-log.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('audit-log')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, PlatformOwnerGuard)
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get()
  async list(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: ListAuditLogQueryDto,
  ): Promise<PaginatedResult<AuditLogEntrySummaryResponse>> {
    return this.auditLogService.listEntries(auth.userId, query);
  }

  /**
   * Task 3 — keyset-paginated feed (`{ items, nextCursor }`, no total) with
   * category/action/actor/tenant/date/search filters. Declared before
   * `:id` so `feed` is never read as an entry id.
   */
  @Get('feed')
  async feed(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: PlatformAuditFeedQueryDto,
  ): Promise<AuditLogCursorPage<AuditLogEntrySummaryResponse>> {
    return this.auditLogService.listFeed(auth.userId, query);
  }

  @Get(':id')
  async getById(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<AuditLogEntryDetailResponse> {
    return this.auditLogService.getEntry(auth.userId, id);
  }
}
