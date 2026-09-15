/**
 * The Add-ons Management data layer — Platform Owner only.
 *
 * TWO DISTINCT STATES, DELIBERATELY NOT CONFLATED. `catalog_status` on
 * `add_ons` is the CUSTOMER-STORE publication state a Platform Owner
 * controls here (draft → coming_soon → published). It is not the same as a
 * tenant's install/enable/entitlement state (`tenant_add_ons`), which stays
 * owned by each academy. Publishing an add-on exposes it in the store; it
 * never installs or enables it for anyone — the two counts below are read
 * only to inform the operator, never written by this page.
 *
 * WHERE EACH FIGURE COMES FROM. The catalog rows come from `add_ons`
 * (platform-owned, no RLS). The install/enabled counts are aggregated from
 * `tenant_add_ons` inside `runInUserContext(platformOwnerId)`, where the
 * `tenant_add_ons_platform_select` RLS policy (P50) is what lets a platform
 * owner — and only a platform owner — see across tenants. The guard decides
 * who may call this; RLS independently agrees.
 *
 * THE STATUS CHANGE IS VERSION-GUARDED AND AUDITED. The update goes through
 * the repo's standard optimistic-concurrency path (`version` in the WHERE
 * clause, `StaleResourceVersionException` on a miss) and writes one
 * `add_on.catalog_status_changed` audit row in the same transaction —
 * actor, add-on, previous and new state, no secrets.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import type { AddOn, Prisma, TenantAddOnStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { StaleResourceVersionException } from '../../concurrency/errors/stale-resource-version.exception';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { PlatformAddOnQueryDto } from '../dto/platform-add-on-query.dto';
import type { UpdateAddOnCatalogStatusDto } from '../dto/update-add-on-catalog-status.dto';
import type {
  PlatformAddOnListResponse,
  PlatformAddOnRow,
} from '../dto/platform-add-on.contract';

/**
 * A `tenant_add_ons` row counts as an INSTALL for every state except a
 * fully torn-down `uninstalled` — installing/installed/enabled/disabled/
 * uninstalling/failed all represent a present install footprint. ENABLED is
 * the narrower "its effect is live right now" state.
 */
const NON_INSTALLED_STATUSES: readonly TenantAddOnStatus[] = ['uninstalled'];

interface AddOnCounts {
  readonly install: number;
  readonly enabled: number;
}

@Injectable()
export class PlatformAddOnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancyContextService: TenancyContextService,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

  async list(
    platformOwnerId: string,
    query: PlatformAddOnQueryDto,
  ): Promise<PlatformAddOnListResponse> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    // The whole catalog (platform-owned, no RLS) plus per-add-on counts read
    // across tenants in platform context. The catalog is small and fixed by
    // the registry, so loading it whole and filtering/paginating in the
    // service is honest and bounded — there is no firehose here.
    const [addOns, countsByAddOnId] = await Promise.all([
      this.prisma.addOn.findMany({ orderBy: { name: 'asc' } }),
      this.countsByAddOnId(platformOwnerId),
    ]);

    const filtered = this.applyFilters(addOns, query);
    const sorted = this.applySort(filtered, query);
    const totalItems = sorted.length;
    const start = (page - 1) * pageSize;
    const items = sorted
      .slice(start, start + pageSize)
      .map((addOn) => this.toRow(addOn, countsByAddOnId.get(addOn.id)));

    return {
      items,
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  async updateCatalogStatus(
    platformOwnerId: string,
    key: string,
    payload: UpdateAddOnCatalogStatusDto,
  ): Promise<PlatformAddOnRow> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.addOn.findUnique({ where: { key } });
      if (!existing) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }

      // The version goes into the WHERE clause so the DATABASE decides the
      // race, not the gap between the read above and this write.
      const result = await tx.addOn.updateMany({
        where: { id: existing.id, version: payload.expectedVersion },
        data: {
          catalogStatus: payload.catalogStatus,
          version: { increment: 1 },
        },
      });

      if (result.count === 0) {
        // Pre-check found the row but the conditional write matched nothing,
        // so someone changed it in between. Same conflict, same contract.
        const current = await tx.addOn.findUnique({ where: { id: existing.id } });
        throw new StaleResourceVersionException({
          submittedVersion: payload.expectedVersion,
          currentVersion: current?.version ?? payload.expectedVersion,
          lastEditedAt: current?.updatedAt.toISOString(),
        });
      }

      const updated = await tx.addOn.findUnique({ where: { id: existing.id } });

      // Audit as part of the same transaction: if the write rolls back, so
      // does this row. Previous and new state, actor, add-on — no secrets.
      await this.auditLogWriterService.write(tx, {
        actorUserId: platformOwnerId,
        role: 'platform_owner',
        action: 'add_on.catalog_status_changed',
        targetType: 'add_on',
        targetId: existing.id,
        targetLabel: existing.name,
        context: {
          addOnKey: existing.key,
          previousStatus: existing.catalogStatus,
          newStatus: payload.catalogStatus,
        },
      });

      const counts = (await this.countsByAddOnId(platformOwnerId)).get(existing.id);
      return this.toRow(updated ?? existing, counts);
    });
  }

  /** Per-add-on install/enabled counts, aggregated across tenants in platform context. */
  private async countsByAddOnId(
    platformOwnerId: string,
  ): Promise<Map<string, AddOnCounts>> {
    const groups = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      (tx: Prisma.TransactionClient) =>
        tx.tenantAddOn.groupBy({
          by: ['addOnId', 'status'],
          _count: { _all: true },
        }),
    );

    const map = new Map<string, AddOnCounts>();
    for (const group of groups) {
      const current = map.get(group.addOnId) ?? { install: 0, enabled: 0 };
      const n = group._count._all;
      const isUninstalled = NON_INSTALLED_STATUSES.includes(group.status);
      map.set(group.addOnId, {
        install: current.install + (isUninstalled ? 0 : n),
        enabled: current.enabled + (group.status === 'enabled' ? n : 0),
      });
    }
    return map;
  }

  private applyFilters(addOns: AddOn[], query: PlatformAddOnQueryDto): AddOn[] {
    const search = query.search?.trim().toLowerCase();
    return addOns.filter((addOn) => {
      if (query.status && addOn.catalogStatus !== query.status) {
        return false;
      }
      if (search) {
        const haystack = [addOn.name, addOn.key, addOn.description ?? '']
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(search)) {
          return false;
        }
      }
      return true;
    });
  }

  private applySort(addOns: AddOn[], query: PlatformAddOnQueryDto): AddOn[] {
    const dir = query.sortDirection === 'desc' ? -1 : 1;
    const field = query.sortBy;
    const rows = [...addOns];
    rows.sort((a, b) => {
      switch (field) {
        case 'catalogStatus':
          return a.catalogStatus.localeCompare(b.catalogStatus) * dir;
        case 'updatedAt':
          return (a.updatedAt.getTime() - b.updatedAt.getTime()) * dir;
        case 'name':
        default:
          return a.name.localeCompare(b.name) * dir;
      }
    });
    return rows;
  }

  private toRow(addOn: AddOn, counts: AddOnCounts | undefined): PlatformAddOnRow {
    return {
      id: addOn.id,
      key: addOn.key,
      name: addOn.name,
      description: addOn.description,
      catalogStatus: addOn.catalogStatus,
      installCount: counts?.install ?? 0,
      enabledCount: counts?.enabled ?? 0,
      version: addOn.version,
      updatedAt: addOn.updatedAt.toISOString(),
    };
  }
}
