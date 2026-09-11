/**
 * AdminSubscriptionsService — platform-wide subscription and trial
 * operations view.
 *
 * EVERY NUMBER HERE IS A REAL AGGREGATE over real rows. There are no
 * placeholder statistics and no sample data anywhere in this file.
 *
 * REVENUE IS DELIBERATELY ABSENT. Atlas records `Payment` rows for course
 * commerce, but it does not track subscription revenue: plan prices are
 * catalog metadata, `tenant_subscriptions` carries no amount, and no
 * ledger ties a subscription to money received. Reporting a
 * "subscription MRR" here would therefore require inventing it from plan
 * list prices and pretending every active subscription is paid in full,
 * on time, at list price — which would be a fabricated number presented
 * as fact. The contract instead exposes `revenue: { tracked: false }`,
 * the same honest shape the tenant dashboard already uses, so the UI can
 * say so plainly rather than render a lie.
 *
 * TENANCY. This is a PLATFORM-OWNER surface and is intentionally
 * cross-tenant: that is its entire purpose. Reachable only behind
 * `PlatformOwnerGuard`, and every query runs inside
 * `runInUserContext(platformOwnerId)` — the same mechanism
 * `PlatformOrganizationsService` already uses — so the P15
 * `*_platform_select` RLS policies grant the cross-tenant reads. RLS is
 * therefore still fully in force here; it is satisfied, not bypassed. A
 * non-platform-owner id in that context would read nothing at all, which
 * is a second, database-level backstop behind the guard.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import type {
  AdminCancellationRow,
  AdminSubscriptionOverview,
} from '../dto/admin-subscription.contract';

/** Cap on the recent-cancellations list. An operations view, not an export. */
const RECENT_CANCELLATIONS_LIMIT = 25;

@Injectable()
export class AdminSubscriptionsService {
  constructor(private readonly tenancyContextService: TenancyContextService) {}

  /**
   * @param platformOwnerId  The acting platform owner. Required, and not
   *   decorative: every query below runs inside
   *   `runInUserContext(platformOwnerId)`, which sets
   *   `app.current_user_id` so the `*_platform_select` RLS policies
   *   (`is_platform_owner(...)`, added in P15) actually grant the
   *   cross-tenant reads this view needs.
   *
   *   Without that context the joins silently return nothing — and where
   *   a relation is required, Prisma fails outright rather than degrading
   *   quietly. That is exactly how this was caught: the endpoint 500'd on
   *   `Field organization is required to return data, got null instead`,
   *   because RLS had filtered the joined organization away.
   */
  async getOverview(platformOwnerId: string): Promise<AdminSubscriptionOverview> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
      this.buildOverview(tx),
    );
  }

  private async buildOverview(
    tx: Prisma.TransactionClient,
  ): Promise<AdminSubscriptionOverview> {
    const now = new Date();

    const [
      organizationCount,
      statusGroups,
      planGroups,
      trialRedemptionCount,
      activeTrialCount,
      cancellationGroups,
      cancellationReasonGroups,
      recentCancellations,
    ] = await Promise.all([
      tx.organization.count(),

      // Subscription status distribution — the operational heart of the
      // view.
      tx.tenantSubscription.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),

      // Plan distribution, by plan id; names resolved below.
      tx.tenantSubscription.groupBy({
        by: ['planId'],
        _count: { _all: true },
      }),

      // Every trial ever redeemed, including those whose organization has
      // since been deleted — `trial_redemptions` is the durable record.
      tx.trialRedemption.count(),

      // Trials live right now: still `trialing` AND not yet expired.
      tx.tenantSubscription.count({
        where: { status: 'trialing', trialEndsAt: { gt: now } },
      }),

      tx.subscriptionCancellation.groupBy({
        by: ['kind'],
        _count: { _all: true },
      }),

      tx.subscriptionCancellation.groupBy({
        by: ['reason'],
        _count: { _all: true },
        orderBy: { _count: { reason: 'desc' } },
      }),

      tx.subscriptionCancellation.findMany({
        orderBy: { cancelledAt: 'desc' },
        take: RECENT_CANCELLATIONS_LIMIT,
        select: {
          id: true,
          kind: true,
          reason: true,
          feedback: true,
          cancelledAt: true,
          effectiveAt: true,
          organization: { select: { id: true, name: true } },
          cancelledByUser: { select: { id: true, name: true } },
        },
      }),
    ]);

    const plans = await tx.plan.findMany({
      where: { id: { in: planGroups.map((row) => row.planId) } },
      select: { id: true, key: true, name: true },
    });
    const planById = new Map(plans.map((plan) => [plan.id, plan]));

    const byStatus = Object.fromEntries(
      statusGroups.map((row) => [row.status, row._count._all]),
    );

    const trialsCancelled =
      cancellationGroups.find((row) => row.kind === 'trial')?._count._all ?? 0;
    const paidCancelled =
      cancellationGroups.find((row) => row.kind === 'paid')?._count._all ?? 0;

    const activePaid =
      (byStatus.active ?? 0) + (byStatus.past_due ?? 0) + (byStatus.grace_period ?? 0);

    return {
      organizations: organizationCount,

      subscriptions: {
        byStatus,
        activePaid,
      },

      trials: {
        /** Every trial ever redeemed — survives organization deletion. */
        everRedeemed: trialRedemptionCount,
        active: activeTrialCount,
        cancelled: trialsCancelled,
        /**
         * Trials that became paying subscriptions. Derived by counting
         * organizations that both redeemed a trial and now hold a paid
         * status — NOT a stored funnel, so it is honest about being a
         * point-in-time derivation rather than a historical record: an
         * organization that converted and later churned is not counted
         * here.
         */
        convertedToPaid: await this.countConvertedTrials(tx),
      },

      cancellations: {
        trials: trialsCancelled,
        paid: paidCancelled,
        byReason: Object.fromEntries(
          cancellationReasonGroups.map((row) => [row.reason, row._count._all]),
        ),
        recent: recentCancellations.map((row): AdminCancellationRow => ({
          id: row.id,
          kind: row.kind,
          reason: row.reason,
          feedback: row.feedback ?? undefined,
          cancelledAt: row.cancelledAt.toISOString(),
          effectiveAt: row.effectiveAt.toISOString(),
          organizationId: row.organization.id,
          organizationName: row.organization.name,
          // Attribution is a name and an id, never an email — the
          // dashboard needs to know WHO acted, not how to contact them.
          cancelledByUserId: row.cancelledByUser?.id,
          cancelledByName: row.cancelledByUser?.name,
        })),
      },

      plans: planGroups
        .map((row) => ({
          planId: row.planId,
          planKey: planById.get(row.planId)?.key ?? 'unknown',
          planName: planById.get(row.planId)?.name ?? 'Unknown plan',
          subscriptions: row._count._all,
        }))
        .sort((a, b) => b.subscriptions - a.subscriptions),

      /**
       * Atlas does not track subscription revenue — see this class's own
       * doc comment. Reported as untracked rather than fabricated.
       */
      revenue: { tracked: false },

      generatedAt: now.toISOString(),
    };
  }

  /**
   * Organizations that redeemed a trial and currently hold a paid status.
   *
   * A single aggregate join rather than loading every redemption id into
   * memory and passing them back as an `IN (...)` list. The first version
   * did exactly that, and it timed out against a database with ~17k
   * academies — an operations dashboard must not get slower as the
   * platform succeeds.
   *
   * `INNER JOIN` naturally skips redemptions whose organization was
   * deleted (`organization_id` is set to NULL rather than cascading), so
   * no explicit null-handling is needed.
   */
  private async countConvertedTrials(tx: Prisma.TransactionClient): Promise<number> {
    const rows = await tx.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count
         FROM trial_redemptions tr
         JOIN tenant_subscriptions ts ON ts.organization_id = tr.organization_id
        WHERE ts.status IN ('active', 'past_due', 'grace_period')`,
    );
    return Number(rows[0]?.count ?? 0);
  }
}
