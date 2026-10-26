/**
 * GrowthReportsService — G1: the CAC report and the season capacity
 * report, from server truth only. Runs in the Platform Owner's context
 * (`organizations_platform_select`, `organization_platform_flags_platform_select`,
 * `payments_platform_review_select`, `checkouts_platform_select`,
 * `payment_reviews_platform_review_select`, `founding_memberships`,
 * `provisioning_requests_platform_select`, `tenant_subscriptions` and
 * `platform_contact_submissions_platform_select` grant the reads).
 *
 * WHICH ORGANIZATIONS COUNT. Never an internal one
 * (`organization_platform_flags.is_internal`) and never an archived
 * (deleted) one, in every number.
 *
 * THE FACTS (verified in code, not guessed):
 *   - PAYING = at least one `payments` row with `status = 'succeeded'` on a
 *     `checkouts.target_type = 'plan_subscription'` checkout — exactly how
 *     MRR (`AdminSubscriptionsService.monthlyRecurringRevenue`) and the
 *     first-paid gift (`PaidGiftEligibilityService`) decide it.
 *   - WHEN IT WAS PAID = the earliest `payment_reviews.reviewed_at` with
 *     `status = 'approved'` for that payment (a manual approval: the moment
 *     `PaymentApplicationService.applySuccessfulPayment` ran), else the
 *     payment's `updated_at` (a gateway success writes no review).
 *   - ONBOARDED = the organization's FIRST `provisioning_requests` row to
 *     reach `status = 'ready'`, at its `completed_at` (stamped by
 *     `ProvisioningOrchestratorService` when the `finalization` step
 *     completes).
 *   - CURRENTLY PAYING (load, hiring) = a paying organization whose
 *     `tenant_subscriptions.status` is `active`, `past_due` or
 *     `grace_period`; ACTIVE TRIAL = `status = 'trialing'`.
 *   - OPEN REQUESTS = `platform_contact_submissions` with `status = 'new'`.
 *
 * Bucketing (Cairo month, Saturday–Friday week) and channel resolution
 * happen in TypeScript on bounded row sets (≤ 36 months of signups, the
 * last 12 weeks), through the same pure functions the unit tests cover.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import {
  resolveAcquisitionChannel,
  type AcquisitionChannelValue,
  type SpendChannel,
} from '../../common/attribution/acquisition-channel';
import type { MonthRangeQueryDto } from '../dto/growth.dto';
import type { CacReportResponse, CapacityReportResponse } from '../dto/growth.contract';
import { CAC_DEFAULT_MONTHS, CAPACITY_WEEKS } from '../growth.constants';
import { resolveMonthRange } from '../month-range';
import {
  addDays,
  addMonths,
  cairoDate,
  cairoMonth,
  cairoStartOfDay,
  cairoStartOfMonth,
  monthRange,
  monthToDateColumn,
  weekStartSaturday,
} from '../growth-time';
import {
  buildCacReport,
  buildCapacityReport,
  bucketByWeek,
  type CohortOrganization,
} from '../growth-math';
import { attributionObject } from '../organization-acquisition.reader';
import { GrowthSettingsService, toCapacitySettings } from './growth-settings.service';
import { OrganizationAcquisitionService } from './organization-acquisition.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Counted organizations: not internal, not archived. `o` / `f` aliases. */
const COUNTED = Prisma.sql`COALESCE(f."is_internal", false) = false AND o."status" <> 'archived'`;

/** `o` has a succeeded plan-subscription payment. */
const HAS_PAID_PLAN = Prisma.sql`EXISTS (
  SELECT 1 FROM "payments" p
  JOIN "checkouts" c ON c."id" = p."checkout_id" AND c."target_type" = 'plan_subscription'
  WHERE p."organization_id" = o."id" AND p."status" = 'succeeded'
)`;

/** A JS instant as a value comparable with a UTC `timestamp(3)` column. */
function utc(instant: Date): Prisma.Sql {
  return Prisma.sql`(${instant.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

interface SignupRow {
  id: string;
  created_at: Date;
  heard_from: AcquisitionChannelValue | null;
  attribution: Prisma.JsonValue | null;
  override: AcquisitionChannelValue | null;
}

@Injectable()
export class GrowthReportsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly settingsService: GrowthSettingsService,
    private readonly acquisitionService: OrganizationAcquisitionService,
  ) {}

  async cac(
    platformOwnerId: string,
    query: MonthRangeQueryDto,
    now: Date = new Date(),
  ): Promise<CacReportResponse> {
    const { from, to } = resolveMonthRange(query, now, CAC_DEFAULT_MONTHS);
    const start = cairoStartOfMonth(from);
    const end = cairoStartOfMonth(addMonths(to, 1));
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const rows = await tx.$queryRaw<
        (SignupRow & { paying: boolean; founding: boolean })[]
      >(
        Prisma.sql`
          SELECT o."id",
                 o."created_at",
                 o."heard_from"::text AS heard_from,
                 o."signup_attribution" AS attribution,
                 f."acquisition_channel_override"::text AS override,
                 ${HAS_PAID_PLAN} AS paying,
                 EXISTS (
                   SELECT 1 FROM "founding_memberships" m
                   WHERE m."organization_id" = o."id" AND m."status" <> 'revoked'
                 ) AS founding
          FROM "organizations" o
          LEFT JOIN "organization_platform_flags" f ON f."organization_id" = o."id"
          WHERE ${COUNTED}
            AND o."created_at" >= ${utc(start)}
            AND o."created_at" < ${utc(end)}
        `,
      );
      const spend = await tx.marketingSpendEntry.groupBy({
        by: ['month', 'channel'],
        where: { month: { gte: monthToDateColumn(from), lte: monthToDateColumn(to) } },
        _sum: { amountMinorUnits: true },
      });
      const organizations: CohortOrganization[] = rows.map((row) => ({
        month: cairoMonth(row.created_at),
        channel: this.channelOf(row),
        paying: row.paying,
        foundingPaying: row.paying && row.founding,
      }));
      return buildCacReport({
        months: monthRange(from, to),
        organizations,
        spend: spend.map((entry) => ({
          month: entry.month.toISOString().slice(0, 7),
          channel: entry.channel as SpendChannel,
          amountMinorUnits: Number(entry._sum.amountMinorUnits ?? 0),
        })),
      });
    });
  }

  async capacity(
    platformOwnerId: string,
    now: Date = new Date(),
  ): Promise<CapacityReportResponse> {
    const today = cairoDate(now);
    const weekStart = weekStartSaturday(today);
    const weekStarts = Array.from({ length: CAPACITY_WEEKS }, (_, i) =>
      addDays(weekStart, -7 * (CAPACITY_WEEKS - 1 - i)),
    );
    const windowStart = cairoStartOfDay(weekStarts[0]);
    const last30Start = new Date(now.getTime() - 30 * DAY_MS);
    const since = windowStart < last30Start ? windowStart : last30Start;

    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const settings = toCapacitySettings(await this.settingsService.load(tx));
      const signups = await tx.$queryRaw<SignupRow[]>(Prisma.sql`
        SELECT o."id",
               o."created_at",
               o."heard_from"::text AS heard_from,
               o."signup_attribution" AS attribution,
               f."acquisition_channel_override"::text AS override
        FROM "organizations" o
        LEFT JOIN "organization_platform_flags" f ON f."organization_id" = o."id"
        WHERE ${COUNTED}
          AND o."created_at" >= ${utc(since)}
          AND o."created_at" <= ${utc(now)}
      `);
      const onboardings = await tx.$queryRaw<{ at: Date }[]>(Prisma.sql`
        SELECT MIN(pr."completed_at") AS at
        FROM "provisioning_requests" pr
        JOIN "organizations" o ON o."id" = pr."organization_id"
        LEFT JOIN "organization_platform_flags" f ON f."organization_id" = o."id"
        WHERE ${COUNTED}
          AND pr."status" = 'ready'
          AND pr."completed_at" IS NOT NULL
        GROUP BY pr."organization_id"
        HAVING MIN(pr."completed_at") >= ${utc(windowStart)}
           AND MIN(pr."completed_at") <= ${utc(now)}
      `);
      const conversions = await tx.$queryRaw<{ at: Date }[]>(Prisma.sql`
        WITH paid AS (
          SELECT p."organization_id",
                 COALESCE(r.approved_at, p."updated_at") AS paid_at
          FROM "payments" p
          JOIN "checkouts" c ON c."id" = p."checkout_id" AND c."target_type" = 'plan_subscription'
          LEFT JOIN LATERAL (
            SELECT MIN(pr."reviewed_at") AS approved_at
            FROM "payment_reviews" pr
            WHERE pr."payment_id" = p."id" AND pr."status" = 'approved'
          ) r ON true
          WHERE p."status" = 'succeeded' AND p."organization_id" IS NOT NULL
        )
        SELECT MIN(paid."paid_at") AS at
        FROM paid
        JOIN "organizations" o ON o."id" = paid."organization_id"
        LEFT JOIN "organization_platform_flags" f ON f."organization_id" = o."id"
        WHERE ${COUNTED}
        GROUP BY paid."organization_id"
        HAVING MIN(paid."paid_at") >= ${utc(windowStart)}
           AND MIN(paid."paid_at") <= ${utc(now)}
      `);
      const [load] = await tx.$queryRaw<{ paying: number; trials: number }[]>(Prisma.sql`
        SELECT COUNT(*) FILTER (
                 WHERE s."status" IN ('active', 'past_due', 'grace_period') AND ${HAS_PAID_PLAN}
               )::int AS paying,
               COUNT(*) FILTER (WHERE s."status" = 'trialing')::int AS trials
        FROM "organizations" o
        JOIN "tenant_subscriptions" s ON s."organization_id" = o."id"
        LEFT JOIN "organization_platform_flags" f ON f."organization_id" = o."id"
        WHERE ${COUNTED}
      `);
      const [requests] = await tx.$queryRaw<{ open: number; oldest: Date | null }[]>(
        Prisma.sql`
          SELECT COUNT(*)::int AS open, MIN("created_at") AS oldest
          FROM "platform_contact_submissions"
          WHERE "status" = 'new'
        `,
      );

      const last30 = signups.filter(
        (row) => row.created_at.getTime() >= last30Start.getTime(),
      );
      const signupWeeks = bucketByWeek(
        weekStarts,
        signups.map((row) => cairoDate(row.created_at)),
        weekStartSaturday,
      );
      const onboardingWeeks = bucketByWeek(
        weekStarts,
        onboardings.map((row) => cairoDate(row.at)),
        weekStartSaturday,
      );
      const conversionWeeks = bucketByWeek(
        weekStarts,
        conversions.map((row) => cairoDate(row.at)),
        weekStartSaturday,
      );

      return buildCapacityReport({
        now,
        today,
        weekStart,
        settings,
        weeks: weekStarts.map((start) => ({
          start,
          signups: signupWeeks.get(start) ?? 0,
          onboardings: onboardingWeeks.get(start) ?? 0,
          paidConversions: conversionWeeks.get(start) ?? 0,
        })),
        payingOrgs: load?.paying ?? 0,
        activeTrials: load?.trials ?? 0,
        openRequests: requests?.open ?? 0,
        oldestOpenRequestAt: requests?.oldest ?? null,
        last30Signups: last30.length,
        last30Attributed: last30.filter((row) => this.channelOf(row) !== 'unknown')
          .length,
      });
    });
  }

  private channelOf(row: SignupRow): AcquisitionChannelValue {
    return resolveAcquisitionChannel({
      override: row.override,
      heardFrom: row.heard_from,
      attribution: attributionObject(row.attribution),
      platformBaseDomain: this.acquisitionService.platformBaseDomain(),
    }).channel;
  }
}
