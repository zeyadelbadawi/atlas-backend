/**
 * PlanHistoryService — administrative change history for one plan, read
 * back out of the audit log (P57).
 *
 * WHY THERE IS NO `plan_price_history` TABLE. Two facts, both verified
 * against the schema before this was written:
 *
 *   1. Historical billing is ALREADY unambiguous. `Payment` snapshots its
 *      own `amountMinorUnits`/`currency`, and `Checkout`/`CourseOrder` each
 *      carry a `snapshot` Json. Editing catalog pricing therefore cannot
 *      retroactively change what any customer was actually charged — the
 *      risk a price-history table is usually built to mitigate does not
 *      exist here.
 *   2. A price history IS a change log, and `audit_log_entries` is Atlas's
 *      change log. It already stores the actor, the timestamp, the target,
 *      and (since P58) a structured `{field: {from, to}}` diff, written
 *      inside the mutation's own transaction so history and change commit
 *      or roll back together.
 *
 * A dedicated table would duplicate that store and introduce a second
 * place for the same fact to live — and be the parallel pricing system
 * this phase was explicitly asked not to build.
 *
 * READ PATH. Runs in `runInUserContext(platformOwnerId)` so the
 * `audit_log_entries_platform_select` policy applies: the guard decides,
 * and RLS independently agrees. The lookup is served by the existing
 * `@@index([targetType, targetId])`, and is paginated because a long-lived
 * plan accumulates an unbounded number of entries.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
} from '../../common/dto/collection-query.dto';
import type { CollectionQueryDto } from '../../common/dto/collection-query.dto';

/**
 * The plan-administration actions this history surfaces. Anything else
 * targeting a plan is ignored rather than rendered as an unlabelled row —
 * the page is a plan change history, not a raw audit dump (the audit page
 * itself is where the unfiltered view lives).
 */
export const PLAN_HISTORY_ACTIONS: readonly string[] = [
  'plan.created',
  'plan.updated',
  'plan.pricing_changed',
  'plan.trial_config_changed',
  'plan.archived',
];

export interface PlanHistoryEntryResponse {
  readonly id: string;
  readonly action: string;
  readonly actor: { readonly id: string; readonly name: string; readonly email?: string };
  readonly occurredAt: string;
  /** `{field: {from, to}}`, already redacted at write time by `AuditLogWriterService`. */
  readonly changes?: Record<string, { from: unknown; to: unknown }>;
  readonly context?: Record<string, unknown>;
}

@Injectable()
export class PlanHistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancyContextService: TenancyContextService,
  ) {}

  async listForPlan(
    platformOwnerId: string,
    key: string,
    query: CollectionQueryDto,
  ): Promise<PaginatedResult<PlanHistoryEntryResponse>> {
    const plan = await this.prisma.plan.findUnique({
      where: { key },
      select: { id: true },
    });
    if (!plan) throw new NotFoundException({ messageKey: 'errors.notFound' });

    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    return this.tenancyContextService.runInUserContext(
      platformOwnerId,
      async (tx) => {
        const where = {
          targetType: 'plan',
          targetId: plan.id,
          action: { in: [...PLAN_HISTORY_ACTIONS] },
        };

        const [rows, totalItems] = await Promise.all([
          tx.auditLogEntry.findMany({
            where,
            // Newest first: "what changed most recently" is the question a
            // price history is opened to answer.
            orderBy: { occurredAt: 'desc' },
            skip: (page - 1) * pageSize,
            take: pageSize,
            include: {
              actor: { select: { id: true, name: true, email: true } },
            },
          }),
          tx.auditLogEntry.count({ where }),
        ]);

        return {
          items: rows.map((row) => ({
            id: row.id,
            action: row.action,
            actor: {
              id: row.actor.id,
              name: row.actor.name,
              email: row.actor.email ?? undefined,
            },
            occurredAt: row.occurredAt.toISOString(),
            changes:
              (row.changes as Record<string, { from: unknown; to: unknown }> | null) ??
              undefined,
            context: (row.context as Record<string, unknown> | null) ?? undefined,
          })),
          pagination: buildPaginationMeta(page, pageSize, totalItems),
        };
      },
    );
  }
}
