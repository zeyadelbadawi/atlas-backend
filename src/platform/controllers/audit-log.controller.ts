/**
 * AuditLogController — `audit-log`/`audit-log/:id` (master plan §21
 * Phase P15), matching `AuditLogService` (atlas frontend)'s flat,
 * cross-tenant `resource = 'audit-log'` exactly. Read-only — there is no
 * frontend write path (the backend is the sole writer, see
 * `AuditLogWriterService`).
 */
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { AuditLogService } from '../services/audit-log.service';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type {
  AuditLogEntryDetailResponse,
  AuditLogEntrySummaryResponse,
} from '../../audit-log/dto/audit-log.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('audit-log')
@UseGuards(JwtAuthGuard, PlatformOwnerGuard)
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get()
  async list(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<AuditLogEntrySummaryResponse>> {
    return this.auditLogService.listEntries(auth.userId, query);
  }

  @Get(':id')
  async getById(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<AuditLogEntryDetailResponse> {
    return this.auditLogService.getEntry(auth.userId, id);
  }
}
