/**
 * DashboardMetricsRepository — the raw aggregation queries behind
 * `GET organizations/:id/dashboard` / `GET academies/:id/dashboard`
 * (Phase 8). Every method takes a `Prisma.TransactionClient` from
 * `TenancyContextService.runInTenantContext(organizationId)`, matching
 * every other repository's established rule — so each table's own
 * existing `*_tenant_select` RLS policy is the independent, database-level
 * half of the scoping, not merely the `where` clauses below.
 *
 * SCOPING — the one thing this file must get exactly right. Every method
 * takes an optional `academyId`:
 *   - present → the row set is narrowed to that ONE Academy (a Manager's
 *     dashboard). The caller has already had that academy id verified as
 *     belonging to this organization by `AcademyScopeGuard`, so this
 *     narrowing can never reach across organizations.
 *   - absent → the row set spans every Academy under the organization
 *     (an Organization Owner's dashboard), scoped transitively through
 *     `academy: { organizationId }` — never an unscoped table read.
 * There is deliberately no third "all academies I'm a member of" mode:
 * the two real dashboards are exactly these two, and inventing a third
 * scope would be inventing a product behavior no route exposes.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/** Narrows every aggregation below to one Academy, or to every Academy under one Organization. */
export interface DashboardScopeFilter {
  readonly organizationId: string;
  readonly academyId?: string;
}

export interface DashboardRevenueTotal {
  readonly currency: string;
  readonly amountMinorUnits: bigint;
}

export type DashboardActivityRow = {
  id: string;
  action: string;
  targetType: string;
  targetLabel: string | null;
  academyId: string | null;
  role: string | null;
  occurredAt: Date;
  actor: { name: string };
};

@Injectable()
export class DashboardMetricsRepository {
  /** `{ academyId }` when scoped to one Academy, `{ academy: { organizationId } }` otherwise — see this class's own SCOPING doc comment. */
  private academyScope(
    scope: DashboardScopeFilter,
  ): { academyId: string } | { academy: { organizationId: string } } {
    return scope.academyId
      ? { academyId: scope.academyId }
      : { academy: { organizationId: scope.organizationId } };
  }

  countAcademies(tx: Prisma.TransactionClient, organizationId: string): Promise<number> {
    return tx.academy.count({ where: { organizationId } });
  }

  countCourses(
    tx: Prisma.TransactionClient,
    scope: DashboardScopeFilter,
  ): Promise<number> {
    return tx.course.count({ where: this.academyScope(scope) });
  }

  countPublishedCourses(
    tx: Prisma.TransactionClient,
    scope: DashboardScopeFilter,
  ): Promise<number> {
    return tx.course.count({
      where: { ...this.academyScope(scope), status: 'published' },
    });
  }

  countStudents(
    tx: Prisma.TransactionClient,
    scope: DashboardScopeFilter,
  ): Promise<number> {
    return tx.academyStudent.count({ where: this.academyScope(scope) });
  }

  /** Active `instructor`-role staff — the same `academy_members` role/status pair `AcademiesService.getStats` already counts, never a different definition of "instructor". */
  countInstructors(
    tx: Prisma.TransactionClient,
    scope: DashboardScopeFilter,
  ): Promise<number> {
    return tx.academyMember.count({
      where: { ...this.academyScope(scope), role: 'instructor', status: 'active' },
    });
  }

  /**
   * Real, signed ledger sums grouped by currency — see
   * `dashboard-overview.contract.ts`'s own header comment for the full
   * account of what this figure means and when it is genuinely absent.
   * Never estimated, never defaulted to zero by this method: an empty
   * array means the ledger truly holds no matching rows.
   */
  async sumRevenueByCurrency(
    tx: Prisma.TransactionClient,
    scope: DashboardScopeFilter,
  ): Promise<DashboardRevenueTotal[]> {
    const groups = await tx.revenueLedgerEntry.groupBy({
      by: ['currency'],
      where: this.academyScope(scope),
      _sum: { amountMinorUnits: true },
    });

    return groups.map((group) => ({
      currency: group.currency,
      amountMinorUnits: group._sum.amountMinorUnits ?? 0n,
    }));
  }

  /**
   * Recent audited activity, newest first. Scoped by `organization_id`
   * always (the `audit_log_entries_tenant_select` policy this phase added
   * agrees independently), PLUS `academy_id` when this is a Manager's
   * Academy-scoped dashboard — so a Manager never sees a sibling
   * Academy's activity, even though both live under the same Organization
   * their RLS context covers.
   */
  findRecentActivity(
    tx: Prisma.TransactionClient,
    scope: DashboardScopeFilter,
    take: number,
  ): Promise<DashboardActivityRow[]> {
    return tx.auditLogEntry.findMany({
      where: {
        organizationId: scope.organizationId,
        ...(scope.academyId ? { academyId: scope.academyId } : {}),
      },
      select: {
        id: true,
        action: true,
        targetType: true,
        targetLabel: true,
        academyId: true,
        role: true,
        occurredAt: true,
        actor: { select: { name: true } },
      },
      orderBy: { occurredAt: 'desc' },
      take,
    });
  }
}
