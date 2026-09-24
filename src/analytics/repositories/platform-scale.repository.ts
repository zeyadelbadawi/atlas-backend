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

  /**
   * P64 Phase 4 §E.5 — the platform's video inventory: stored minutes and
   * asset counts per security tier, assets per provider, and the processing
   * pipeline's state (a growing `failed`/`processing` count IS the provider
   * health signal the dashboard shows). Active assets only; `durationSeconds`
   * is NULL until processing reports it, so minutes count ready assets.
   * Runs under the platform owner's RLS context like every read here.
   */
  async videoInventory(tx: Prisma.TransactionClient): Promise<{
    byTier: { tier: string | null; assets: number; seconds: number; bytes: number }[];
    byProvider: { provider: string; assets: number }[];
    byProcessing: { status: string; assets: number }[];
  }> {
    const [byTier, byProvider, byProcessing] = await Promise.all([
      tx.$queryRaw<
        { tier: string | null; assets: number; seconds: number; bytes: number }[]
      >`
        SELECT "security_tier"::text AS tier,
               COUNT(*)::int AS assets,
               COALESCE(SUM("duration_seconds"), 0)::float AS seconds,
               COALESCE(SUM("size_bytes"), 0)::float AS bytes
        FROM "media_assets"
        WHERE "type" = 'video' AND "status" = 'active'
        GROUP BY "security_tier"
      `,
      tx.$queryRaw<{ provider: string; assets: number }[]>`
        SELECT "provider"::text AS provider, COUNT(*)::int AS assets
        FROM "media_assets"
        WHERE "type" = 'video' AND "status" = 'active'
        GROUP BY "provider"
      `,
      tx.$queryRaw<{ status: string; assets: number }[]>`
        SELECT "processing_status"::text AS status, COUNT(*)::int AS assets
        FROM "media_assets"
        WHERE "type" = 'video' AND "status" = 'active'
        GROUP BY "processing_status"
      `,
    ]);
    return { byTier, byProvider, byProcessing };
  }

  // --- P64 Phase 4 §E.5 — commerce / delivery ops (tx, RLS) -----------

  /**
   * `course_orders` created in `[from, now]`, bucketed by CURRENT status.
   * One `GROUP BY`; the service maps every `CourseOrderStatus` value.
   */
  async courseOrdersCreatedByStatus(
    tx: Prisma.TransactionClient,
    from: Date,
  ): Promise<{ status: string; orders: number }[]> {
    return tx.$queryRaw<{ status: string; orders: number }[]>`
      SELECT "status"::text AS status, COUNT(*)::int AS orders
      FROM "course_orders"
      WHERE "created_at" >= ${from}
      GROUP BY "status"
    `;
  }

  /** Course-order payments (`course_order_id IS NOT NULL`) whose manual review is still `pending` — all time, it is a backlog. */
  async courseOrderPaymentsAwaitingReview(tx: Prisma.TransactionClient): Promise<number> {
    const rows = await tx.$queryRaw<{ pending: number }[]>`
      SELECT COUNT(*)::int AS pending
      FROM "payments"
      WHERE "course_order_id" IS NOT NULL AND "review_status" = 'pending'
    `;
    return rows[0]?.pending ?? 0;
  }

  /** `payment_reviews` decisions on course-order payments with `reviewed_at >= from`, per decision status (`approved` | `rejected`). */
  async courseOrderPaymentReviewsByStatus(
    tx: Prisma.TransactionClient,
    from: Date,
  ): Promise<{ status: string; reviews: number }[]> {
    return tx.$queryRaw<{ status: string; reviews: number }[]>`
      SELECT r."status"::text AS status, COUNT(*)::int AS reviews
      FROM "payment_reviews" r
      JOIN "payments" p ON p."id" = r."payment_id"
      WHERE p."course_order_id" IS NOT NULL AND r."reviewed_at" >= ${from}
      GROUP BY r."status"
    `;
  }

  /**
   * Proof-upload → approval latency over the `cap` most recent approvals
   * of course-order payments in `[from, now]`. Measured exactly the way
   * `PlatformCourseOrderPaymentsService.approve` reports it to Prometheus:
   * from the LATEST proof uploaded at or before the decision. An approval
   * with no proof row has nothing to measure and is excluded from the
   * sample. Percentiles are computed in SQL (`percentile_cont`) over the
   * capped sample, never by fetching rows; `sampleSize` reports how many
   * were included so the caller can flag truncation.
   */
  async courseOrderApprovalLatency(
    tx: Prisma.TransactionClient,
    from: Date,
    cap: number,
  ): Promise<{ sampleSize: number; p50: number | null; p95: number | null }> {
    const rows = await tx.$queryRaw<
      { sample_size: number; p50: number | null; p95: number | null }[]
    >`
      WITH samples AS (
        SELECT EXTRACT(EPOCH FROM (r."reviewed_at" - pp."uploaded_at"))::float AS seconds
        FROM "payment_reviews" r
        JOIN "payments" p ON p."id" = r."payment_id"
        JOIN LATERAL (
          SELECT MAX(pr."uploaded_at") AS uploaded_at
          FROM "payment_proofs" pr
          WHERE pr."payment_id" = r."payment_id" AND pr."uploaded_at" <= r."reviewed_at"
        ) pp ON TRUE
        WHERE r."status" = 'approved'
          AND p."course_order_id" IS NOT NULL
          AND r."reviewed_at" >= ${from}
          AND pp."uploaded_at" IS NOT NULL
        ORDER BY r."reviewed_at" DESC
        LIMIT ${cap}
      )
      SELECT COUNT(*)::int AS sample_size,
             (percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds))::float AS p50,
             (percentile_cont(0.95) WITHIN GROUP (ORDER BY seconds))::float AS p95
      FROM samples
    `;
    const row = rows[0];
    return {
      sampleSize: row?.sample_size ?? 0,
      p50: row?.p50 ?? null,
      p95: row?.p95 ?? null,
    };
  }

  /** `course_order_refunds`: requested in the window (any status) and completed (`succeeded`, `processed_at`) in the window. */
  async courseOrderRefundCounts(
    tx: Prisma.TransactionClient,
    from: Date,
  ): Promise<{ requested: number; completed: number }> {
    const rows = await tx.$queryRaw<{ requested: number; completed: number }[]>`
      SELECT
        COUNT(*) FILTER (WHERE "requested_at" >= ${from})::int AS requested,
        COUNT(*) FILTER (
          WHERE "status" = 'succeeded' AND "processed_at" IS NOT NULL AND "processed_at" >= ${from}
        )::int AS completed
      FROM "course_order_refunds"
    `;
    return { requested: rows[0]?.requested ?? 0, completed: rows[0]?.completed ?? 0 };
  }

  /**
   * Frozen snapshot price of orders CURRENTLY `paid` with `paid_at >= from`,
   * summed per snapshot currency — the `CheckoutSnapshot` discipline: the
   * price the buyer actually agreed to, never the live course price.
   */
  async paidOrderRevenueByCurrency(
    tx: Prisma.TransactionClient,
    from: Date,
  ): Promise<{ currency: string; minorUnits: number }[]> {
    const rows = await tx.$queryRaw<{ currency: string; minor_units: number }[]>`
      SELECT "snapshot"->'price'->>'currency' AS currency,
             COALESCE(SUM(("snapshot"->'price'->>'amountMinorUnits')::numeric), 0)::float AS minor_units
      FROM "course_orders"
      WHERE "status" = 'paid' AND "paid_at" IS NOT NULL AND "paid_at" >= ${from}
      GROUP BY 1
    `;
    return rows
      .filter((r) => r.currency !== null)
      .map((r) => ({ currency: r.currency, minorUnits: r.minor_units }));
  }

  /**
   * `content_access_log` decisions in `[from, now]`, grouped by result and
   * reason, over the `cap` most recent rows (the same 50 000 ceiling
   * `AcademyReportsService` applies, so a runaway window can never
   * become a full-table aggregate).
   */
  async contentAccessDecisions(
    tx: Prisma.TransactionClient,
    from: Date,
    cap: number,
  ): Promise<{ result: string; reason: string | null; rows: number }[]> {
    return tx.$queryRaw<{ result: string; reason: string | null; rows: number }[]>`
      SELECT s."result"::text AS result, s."reason" AS reason, COUNT(*)::int AS rows
      FROM (
        SELECT "result", "reason"
        FROM "content_access_log"
        WHERE "created_at" >= ${from}
        ORDER BY "created_at" DESC
        LIMIT ${cap}
      ) s
      GROUP BY s."result", s."reason"
    `;
  }

  /** Rows the retention sweep should already have removed: `content_access_log.created_at` / `quiz_attempt_events.server_at` older than their cutoffs. */
  async retentionBacklog(
    tx: Prisma.TransactionClient,
    accessLogCutoff: Date,
    quizEventsCutoff: Date,
  ): Promise<{ contentAccessLogRows: number; quizAttemptEventRows: number }> {
    const [accessLog, quizEvents] = await Promise.all([
      tx.$queryRaw<{ rows: number }[]>`
        SELECT COUNT(*)::int AS rows FROM "content_access_log" WHERE "created_at" < ${accessLogCutoff}
      `,
      tx.$queryRaw<{ rows: number }[]>`
        SELECT COUNT(*)::int AS rows FROM "quiz_attempt_events" WHERE "server_at" < ${quizEventsCutoff}
      `,
    ]);
    return {
      contentAccessLogRows: accessLog[0]?.rows ?? 0,
      quizAttemptEventRows: quizEvents[0]?.rows ?? 0,
    };
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
