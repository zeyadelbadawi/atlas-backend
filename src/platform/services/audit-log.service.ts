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
import type { ListAuditLogQueryDto } from '../dto/list-audit-log-query.dto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogEntriesRepository } from '../../audit-log/repositories/audit-log-entries.repository';
import {
  toAuditLogEntryDetailResponse,
  toAuditLogEntrySummaryResponse,
  toCursorPage,
} from '../../audit-log/dto/audit-log.contract';
import type {
  AuditLogCursorPage,
  AuditLogEntryDetailResponse,
  AuditLogEntrySummaryResponse,
} from '../../audit-log/dto/audit-log.contract';
import type { PlatformAuditFeedQueryDto } from '../../audit-log/dto/audit-feed-query.dto';
import { buildAuditFeedFilter } from '../../audit-log/utils/audit-feed.util';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';

@Injectable()
export class AuditLogService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly auditLogEntriesRepository: AuditLogEntriesRepository,
  ) {}

  async listEntries(
    platformOwnerId: string,
    query: ListAuditLogQueryDto,
  ): Promise<PaginatedResult<AuditLogEntrySummaryResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems, names } =
      await this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
        const result = await this.auditLogEntriesRepository.findMany(tx, {
          search: query.search,
          sortDirection: query.sortDirection,
          skip: (page - 1) * pageSize,
          take: pageSize,
          // P58 — operational filters. Parsed to Date here rather than in
          // the repository so the repository keeps taking domain types.
          action: query.action,
          actorUserId: query.actorUserId,
          targetType: query.targetType,
          organizationId: query.organizationId,
          academyId: query.academyId,
          occurredFrom: query.occurredFrom ? new Date(query.occurredFrom) : undefined,
          occurredTo: query.occurredTo ? new Date(query.occurredTo) : undefined,
        });
        return {
          ...result,
          names: await this.auditLogEntriesRepository.loadReferenceNames(
            tx,
            result.items,
          ),
        };
      });

    return {
      items: items.map((item) => toAuditLogEntrySummaryResponse(item, names)),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  /**
   * Task 3 — the cursor feed behind the Platform audit pages. Same RLS
   * context and filters as `listEntries`, plus `category`, but keyset-
   * paginated with no `count()`: the audit table only grows, and an exact
   * total is not worth a full index scan on every page view.
   */
  async listFeed(
    platformOwnerId: string,
    query: PlatformAuditFeedQueryDto,
  ): Promise<AuditLogCursorPage<AuditLogEntrySummaryResponse>> {
    const filter = buildAuditFeedFilter(query);
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const rows = await this.auditLogEntriesRepository.findFeedPage(tx, {
        ...filter,
        organizationId: query.organizationId,
        academyId: query.academyId,
      });
      const names = await this.auditLogEntriesRepository.loadReferenceNames(tx, rows);
      return toCursorPage(rows, filter.take, (row) =>
        toAuditLogEntrySummaryResponse(row, names),
      );
    });
  }

  async getEntry(
    platformOwnerId: string,
    entryId: string,
  ): Promise<AuditLogEntryDetailResponse> {
    const result = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      async (tx) => {
        const entry = await this.auditLogEntriesRepository.findById(tx, entryId);
        if (!entry) return null;
        return {
          entry,
          names: await this.auditLogEntriesRepository.loadReferenceNames(tx, [entry]),
        };
      },
    );
    if (!result) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    return toAuditLogEntryDetailResponse(result.entry, result.names);
  }
}
