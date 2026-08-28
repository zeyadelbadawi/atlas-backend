/**
 * AuditLogService (Platform read side) — `GET /audit-log`/`GET
 * /audit-log/:id` (master plan §21 Phase P15). Runs under
 * `TenancyContextService.runInUserContext(platformOwnerId)`, relying on
 * the `audit_log_entries_platform_select` RLS policy — never a second,
 * ungated query path. The WRITE side (`AuditLogWriterService`) lives in
 * the separate, `@Global()` `AuditLogModule` — see that module's own doc
 * comment for why reads and writes are deliberately split across two
 * modules.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogEntriesRepository } from '../../audit-log/repositories/audit-log-entries.repository';
import {
  toAuditLogEntryDetailResponse,
  toAuditLogEntrySummaryResponse,
} from '../../audit-log/dto/audit-log.contract';
import type {
  AuditLogEntryDetailResponse,
  AuditLogEntrySummaryResponse,
} from '../../audit-log/dto/audit-log.contract';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { CollectionQueryDto } from '../../common/dto/collection-query.dto';

@Injectable()
export class AuditLogService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly auditLogEntriesRepository: AuditLogEntriesRepository,
  ) {}

  async listEntries(
    platformOwnerId: string,
    query: CollectionQueryDto,
  ): Promise<PaginatedResult<AuditLogEntrySummaryResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      (tx) =>
        this.auditLogEntriesRepository.findMany(tx, {
          search: query.search,
          sortDirection: query.sortDirection,
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );

    return {
      items: items.map(toAuditLogEntrySummaryResponse),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  async getEntry(
    platformOwnerId: string,
    entryId: string,
  ): Promise<AuditLogEntryDetailResponse> {
    const entry = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      (tx) => this.auditLogEntriesRepository.findById(tx, entryId),
    );
    if (!entry) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    return toAuditLogEntryDetailResponse(entry);
  }
}
