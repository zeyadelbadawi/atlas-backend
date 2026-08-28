/**
 * PlatformScaleRepository — the "how many X exist" half of P16 (master
 * plan §21 Phase P16): Organizations/Academies/Courses/Users counts, plus
 * the platform-wide storage-usage ratio. Every count is a single indexed
 * `COUNT`/`GROUP BY`, never a full-row fetch (master plan §27's N+1/
 * in-memory-aggregation rule).
 *
 * `organizations`/`academies`/`courses` are RLS-protected — every method
 * touching them takes the caller's own `Prisma.TransactionClient`, opened
 * under `TenancyContextService.runInUserContext(platformOwnerId)` by the
 * service layer, reusing the exact `_platform_select` policies P15 already
 * added (no new RLS needed this phase — see this module's own doc
 * comment). `users`/`plans` carry no RLS at all (P1/P4's own established
 * precedent, reused verbatim by `PlatformUsersRepository`) — those methods
 * take the raw `PrismaService` instead, exactly like that repository.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class PlatformScaleRepository {
  constructor(private readonly prisma: PrismaService) {}

  // --- RLS-protected tables (tx) -------------------------------------

  countOrganizations(tx: Prisma.TransactionClient, asOf?: Date): Promise<number> {
    return tx.organization.count({
      where: asOf ? { createdAt: { lte: asOf } } : undefined,
    });
  }

  countAcademies(tx: Prisma.TransactionClient, asOf?: Date): Promise<number> {
    return tx.academy.count({ where: asOf ? { createdAt: { lte: asOf } } : undefined });
  }

  countPublishedCourses(tx: Prisma.TransactionClient, asOf?: Date): Promise<number> {
    return tx.course.count({
      where: { status: 'published', ...(asOf ? { createdAt: { lte: asOf } } : {}) },
    });
  }

  /**
   * `SUM(tenant_usage.general_storage_gb + video_storage_gb)` vs the
   * platform's total effective storage quota (`plans.limits` joined
   * through each Organization's current `tenant_subscriptions.plan_id` —
   * a single batched join, never one `EntitlementService` call per
   * Organization). An Organization on an `'unlimited'` storage plan
   * contributes to neither side of the ratio — its usage is real but has
   * no finite quota to measure against, so including it would make the
   * ratio meaningless (matches this method's own doc comment in
   * `Reports/ARCHITECTURE.md`: "unlimited-quota organizations are
   * excluded from the ratio, not treated as a 0 or an infinite quota").
   */
  async storageUsageRatio(
    tx: Prisma.TransactionClient,
  ): Promise<{ usedGb: number; quotaGb: number }> {
    const rows = await tx.$queryRaw<{ used_gb: number; quota_gb: number }[]>`
      SELECT
        COALESCE(SUM(tu."general_storage_gb" + tu."video_storage_gb"), 0)::float AS used_gb,
        COALESCE(SUM(
          CASE
            WHEN p."limits"->>'generalStorage' = 'unlimited' OR p."limits"->>'videoStorage' = 'unlimited' THEN 0
            ELSE (p."limits"->>'generalStorage')::numeric + (p."limits"->>'videoStorage')::numeric
          END
        ), 0)::float AS quota_gb
      FROM "tenant_usage" tu
      JOIN "tenant_subscriptions" ts ON ts."organization_id" = tu."organization_id"
      JOIN "plans" p ON p."id" = ts."plan_id"
      WHERE p."limits"->>'generalStorage' != 'unlimited' AND p."limits"->>'videoStorage' != 'unlimited'
    `;
    const row = rows[0];
    return { usedGb: row?.used_gb ?? 0, quotaGb: row?.quota_gb ?? 0 };
  }

  // --- Unprotected tables (no RLS) ------------------------------------

  countUsers(asOf?: Date): Promise<number> {
    return this.prisma.user.count({
      where: asOf ? { createdAt: { lte: asOf } } : undefined,
    });
  }

  countActiveUsers(from: Date, to: Date): Promise<number> {
    return this.prisma.user.count({ where: { lastSignInAt: { gte: from, lte: to } } });
  }

  /** One `GROUP BY` per day a user was ever created, up to `to` (a small, bounded result — one row per distinct day, never one row per user) — the service layer fills gaps and computes the running cumulative total. */
  async usersCreatedByDay(to: Date): Promise<{ day: string; count: number }[]> {
    const rows = await this.prisma.$queryRaw<{ day: Date; count: bigint }[]>`
      SELECT date_trunc('day', "created_at") AS day, COUNT(*) AS count
      FROM "users"
      WHERE "created_at" <= ${to}
      GROUP BY 1
      ORDER BY 1
    `;
    return rows.map((r) => ({
      day: r.day.toISOString().slice(0, 10),
      count: Number(r.count),
    }));
  }

  /** Active-user counts bucketed by day, `lastSignInAt` within `[from, to]` — bounded to the requested window only (an "active" event, unlike a signup, has no meaningful "before the window" carry-forward). */
  async activeUsersByDay(
    from: Date,
    to: Date,
  ): Promise<{ day: string; count: number }[]> {
    const rows = await this.prisma.$queryRaw<{ day: Date; count: bigint }[]>`
      SELECT date_trunc('day', "last_sign_in_at") AS day, COUNT(*) AS count
      FROM "users"
      WHERE "last_sign_in_at" >= ${from} AND "last_sign_in_at" <= ${to}
      GROUP BY 1
      ORDER BY 1
    `;
    return rows.map((r) => ({
      day: r.day.toISOString().slice(0, 10),
      count: Number(r.count),
    }));
  }
}
