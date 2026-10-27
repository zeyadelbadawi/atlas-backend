/**
 * MarketingSpendService — G1: the monthly cash spend ledger
 * (`marketing_spend_entries`, EGP minor units). Platform Owner only, reads
 * included (RLS). Cash only: founder hours are never a cost here.
 *
 * Edits compare `version` → 409 `errors.growth.spendStale` (code
 * `MARKETING_SPEND_STALE`). Every write is audited in its transaction.
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { MarketingSpendEntry, Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import type {
  CreateSpendEntryDto,
  MonthRangeQueryDto,
  UpdateSpendEntryDto,
} from '../dto/growth.dto';
import type { SpendEntryResponse, SpendListResponse } from '../dto/growth.contract';
import type { SpendChannel } from '../../common/attribution/acquisition-channel';
import {
  GROWTH_AUDIT,
  GROWTH_ERRORS,
  GROWTH_ROLE,
  MARKETING_SPEND_STALE_CODE,
  SPEND_DEFAULT_MONTHS,
} from '../growth.constants';
import { resolveMonthRange } from '../month-range';
import { monthToDateColumn } from '../growth-time';
import { userNames } from '../user-names';

const TARGET_TYPE = 'marketing_spend_entry';

const ORDER: Prisma.MarketingSpendEntryOrderByWithRelationInput[] = [
  { month: 'desc' },
  { channel: 'asc' },
  { createdAt: 'asc' },
  { id: 'asc' },
];

@Injectable()
export class MarketingSpendService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

  async list(
    platformOwnerId: string,
    query: MonthRangeQueryDto,
    now: Date = new Date(),
  ): Promise<SpendListResponse> {
    const { from, to } = resolveMonthRange(query, now, SPEND_DEFAULT_MONTHS);
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const rows = await tx.marketingSpendEntry.findMany({
        where: { month: { gte: monthToDateColumn(from), lte: monthToDateColumn(to) } },
        orderBy: ORDER,
      });
      const names = await userNames(
        tx,
        rows.flatMap((row) => [row.createdByUserId, row.updatedByUserId]),
      );
      return { from, to, items: rows.map((row) => this.toResponse(row, names)) };
    });
  }

  async create(
    platformOwnerId: string,
    payload: CreateSpendEntryDto,
  ): Promise<SpendEntryResponse> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const created = await tx.marketingSpendEntry.create({
        data: {
          month: monthToDateColumn(payload.month),
          channel: payload.channel,
          amountMinorUnits: BigInt(payload.amountMinorUnits),
          currency: 'EGP',
          description: payload.description ?? null,
          createdByUserId: platformOwnerId,
          updatedByUserId: platformOwnerId,
        },
      });
      await this.audit(tx, platformOwnerId, GROWTH_AUDIT.spendCreated, created, {});
      return this.loadOne(tx, created.id);
    });
  }

  async update(
    platformOwnerId: string,
    id: string,
    payload: UpdateSpendEntryDto,
  ): Promise<SpendEntryResponse> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM marketing_spend_entries WHERE id = ${id} FOR UPDATE`;
      if (locked.length === 0) {
        throw new NotFoundException({ messageKey: GROWTH_ERRORS.spendNotFound });
      }
      const current = await tx.marketingSpendEntry.findUniqueOrThrow({ where: { id } });
      if (current.version !== payload.version) {
        throw new ConflictException({
          messageKey: GROWTH_ERRORS.spendStale,
          code: MARKETING_SPEND_STALE_CODE,
        });
      }
      const data: Prisma.MarketingSpendEntryUpdateInput = {};
      const changed: string[] = [];
      if (payload.month !== undefined && payload.month !== monthOf(current)) {
        data.month = monthToDateColumn(payload.month);
        changed.push('month');
      }
      if (payload.channel !== undefined && payload.channel !== current.channel) {
        data.channel = payload.channel;
        changed.push('channel');
      }
      if (
        payload.amountMinorUnits !== undefined &&
        BigInt(payload.amountMinorUnits) !== current.amountMinorUnits
      ) {
        data.amountMinorUnits = BigInt(payload.amountMinorUnits);
        changed.push('amountMinorUnits');
      }
      if (
        payload.description !== undefined &&
        payload.description !== current.description
      ) {
        data.description = payload.description;
        changed.push('description');
      }
      if (changed.length === 0) return this.loadOne(tx, id);

      const updated = await tx.marketingSpendEntry.update({
        where: { id },
        data: { ...data, updatedByUserId: platformOwnerId, version: { increment: 1 } },
      });
      await this.audit(tx, platformOwnerId, GROWTH_AUDIT.spendUpdated, updated, {
        changedFields: changed.join(','),
      });
      return this.loadOne(tx, id);
    });
  }

  async remove(platformOwnerId: string, id: string): Promise<void> {
    await this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const current = await tx.marketingSpendEntry.findUnique({ where: { id } });
      if (!current)
        throw new NotFoundException({ messageKey: GROWTH_ERRORS.spendNotFound });
      await tx.marketingSpendEntry.delete({ where: { id } });
      await this.audit(tx, platformOwnerId, GROWTH_AUDIT.spendDeleted, current, {});
    });
  }

  private async loadOne(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<SpendEntryResponse> {
    const row = await tx.marketingSpendEntry.findUnique({ where: { id } });
    if (!row) throw new NotFoundException({ messageKey: GROWTH_ERRORS.spendNotFound });
    const names = await userNames(tx, [row.createdByUserId, row.updatedByUserId]);
    return this.toResponse(row, names);
  }

  private toResponse(
    row: MarketingSpendEntry,
    names: Map<string, string>,
  ): SpendEntryResponse {
    return {
      id: row.id,
      month: monthOf(row),
      channel: row.channel as SpendChannel,
      amountMinorUnits: Number(row.amountMinorUnits),
      currency: 'EGP',
      description: row.description,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      createdByName: names.get(row.createdByUserId) ?? null,
      updatedByName: names.get(row.updatedByUserId) ?? null,
    };
  }

  private async audit(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    action: (typeof GROWTH_AUDIT)[keyof typeof GROWTH_AUDIT],
    row: MarketingSpendEntry,
    extra: Record<string, string>,
  ): Promise<void> {
    const month = monthOf(row);
    await this.auditLogWriterService.write(tx, {
      actorUserId,
      role: GROWTH_ROLE,
      action,
      targetType: TARGET_TYPE,
      targetId: row.id,
      targetLabel: `${month} ${row.channel}`,
      context: {
        month,
        channel: row.channel,
        amountMinorUnits: Number(row.amountMinorUnits),
        ...extra,
      },
    });
  }
}

function monthOf(row: Pick<MarketingSpendEntry, 'month'>): string {
  return row.month.toISOString().slice(0, 7);
}
