/**
 * B0-ANL-04 (part 3) — the Platform Owner's "Growth" activation funnel,
 * from server truth only (no client analytics, no browser storage).
 *
 * COHORTS BY SIGNUP WEEK. Each row is the organizations CREATED in one
 * Africa/Cairo week (weeks start Monday, ISO), and how many of them have
 * reached each activation step SO FAR:
 *
 *   signups → academy created → course published → first enrolment →
 *   first succeeded (approved) subscription payment.
 *
 * Internal organizations (`organization_platform_flags.is_internal`,
 * B0-ANL-04 part 1) are excluded from every number. Runs in the Platform
 * Owner's context: `organizations_platform_select`,
 * `organization_platform_flags_platform_select`, `academies_platform_select`,
 * `courses_platform_select`, `enrollments_platform_select` and
 * `payments_platform_review_select` grant the reads. A bounded window
 * (≤ 26 weeks of cohorts) and EXISTS probes on indexed foreign keys keep it
 * one aggregate query. Every week of the window is returned, zeros included.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export const GROWTH_TIME_ZONE = 'Africa/Cairo';

export interface GrowthCohortRow {
  readonly weekStart: string;
  readonly signups: number;
  readonly academyCreated: number;
  readonly coursePublished: number;
  readonly firstEnrolment: number;
  readonly firstPayment: number;
}

export interface GrowthSourceRow {
  /** `utmSource`, else the referrer domain; `null` = untagged. */
  readonly source: string | null;
  readonly signups: number;
}

@Injectable()
export class PlatformGrowthRepository {
  /** The Monday (Africa/Cairo) that starts the earliest cohort in the window. */
  private windowStart(now: Date, weeks: number): Prisma.Sql {
    return Prisma.sql`(date_trunc('week', (${now.toISOString()}::timestamptz AT TIME ZONE ${GROWTH_TIME_ZONE}))
      - make_interval(weeks => ${weeks - 1}::int))`;
  }

  async cohorts(
    tx: Prisma.TransactionClient,
    now: Date,
    weeks: number,
  ): Promise<GrowthCohortRow[]> {
    const rows = await tx.$queryRaw<
      {
        week_start: string;
        signups: number;
        academy_created: number;
        course_published: number;
        first_enrolment: number;
        first_payment: number;
      }[]
    >(Prisma.sql`
      WITH weeks AS (
        SELECT generate_series(
                 ${this.windowStart(now, weeks)},
                 date_trunc('week', (${now.toISOString()}::timestamptz AT TIME ZONE ${GROWTH_TIME_ZONE})),
                 interval '1 week'
               )::date AS week_start
      ),
      cohort AS (
        SELECT o."id",
               date_trunc('week', (o."created_at" AT TIME ZONE 'UTC') AT TIME ZONE ${GROWTH_TIME_ZONE})::date AS week_start
        FROM "organizations" o
        LEFT JOIN "organization_platform_flags" f ON f."organization_id" = o."id"
        WHERE COALESCE(f."is_internal", false) = false
          AND ((o."created_at" AT TIME ZONE 'UTC') AT TIME ZONE ${GROWTH_TIME_ZONE}) >= ${this.windowStart(now, weeks)}
          AND o."created_at" <= ${now.toISOString()}::timestamptz AT TIME ZONE 'UTC'
      )
      SELECT w.week_start::text AS week_start,
             COUNT(c."id")::int AS signups,
             COUNT(c."id") FILTER (WHERE EXISTS (
               SELECT 1 FROM "academies" a WHERE a."organization_id" = c."id"
             ))::int AS academy_created,
             COUNT(c."id") FILTER (WHERE EXISTS (
               SELECT 1 FROM "courses" co JOIN "academies" a ON a."id" = co."academy_id"
               WHERE a."organization_id" = c."id"
                 AND (co."published_at" IS NOT NULL OR co."status" = 'published')
             ))::int AS course_published,
             COUNT(c."id") FILTER (WHERE EXISTS (
               SELECT 1 FROM "enrollments" e JOIN "academies" a ON a."id" = e."academy_id"
               WHERE a."organization_id" = c."id" AND e."status" IN ('enrolled', 'completed')
             ))::int AS first_enrolment,
             COUNT(c."id") FILTER (WHERE EXISTS (
               SELECT 1 FROM "payments" p
               WHERE p."organization_id" = c."id" AND p."status" = 'succeeded'
             ))::int AS first_payment
      FROM weeks w
      LEFT JOIN cohort c ON c.week_start = w.week_start
      GROUP BY w.week_start
      ORDER BY w.week_start
    `);
    return rows.map((row) => ({
      weekStart: row.week_start,
      signups: row.signups,
      academyCreated: row.academy_created,
      coursePublished: row.course_published,
      firstEnrolment: row.first_enrolment,
      firstPayment: row.first_payment,
    }));
  }

  /** Signups in the same window by stored attribution source (top 10, untagged included). */
  async sources(
    tx: Prisma.TransactionClient,
    now: Date,
    weeks: number,
  ): Promise<GrowthSourceRow[]> {
    const rows = await tx.$queryRaw<
      { source: string | null; signups: number }[]
    >(Prisma.sql`
      SELECT COALESCE(o."signup_attribution"->>'utmSource',
                      o."signup_attribution"->>'referrerDomain') AS source,
             COUNT(*)::int AS signups
      FROM "organizations" o
      LEFT JOIN "organization_platform_flags" f ON f."organization_id" = o."id"
      WHERE COALESCE(f."is_internal", false) = false
        AND ((o."created_at" AT TIME ZONE 'UTC') AT TIME ZONE ${GROWTH_TIME_ZONE}) >= ${this.windowStart(now, weeks)}
        AND o."created_at" <= ${now.toISOString()}::timestamptz AT TIME ZONE 'UTC'
      GROUP BY 1
      ORDER BY 2 DESC, 1 ASC NULLS LAST
      LIMIT 10
    `);
    return rows.map((row) => ({ source: row.source, signups: row.signups }));
  }
}
