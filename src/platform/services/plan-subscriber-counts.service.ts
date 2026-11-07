import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';

/**
 * How many organizations are on a plan, as the Platform Owner console
 * shows it (plan management, item 9 of the UX audit decisions).
 *
 * - `paying`: the subscription is on the plan and paid for (`active`,
 *   `past_due`, `grace_period`: the same set the admin overview and the
 *   growth reports call paying).
 * - `trialing`: on the plan in a trial that has not ended yet.
 * - `scheduledIn`: a downgrade or switch INTO the plan is booked for a
 *   future date.
 * - `foundingLocks`: active Founding Academy memberships locked to the plan.
 *
 * Organizations without a plan (`no_plan`), whose trial ended, or whose
 * subscription was cancelled, expired or paused are not counted: their
 * `planId` only points at a placeholder or a past plan.
 *
 * Cross-tenant reads: every query runs inside `runInUserContext` so the
 * `*_platform_select` RLS policies grant them (without it they count 0).
 */
export interface PlanSubscriberCounts {
  readonly paying: number;
  readonly trialing: number;
  readonly scheduledIn: number;
  readonly foundingLocks: number;
}

export const ZERO_SUBSCRIBER_COUNTS: PlanSubscriberCounts = {
  paying: 0,
  trialing: 0,
  scheduledIn: 0,
  foundingLocks: 0,
};

const PAYING_STATUSES = ['active', 'past_due', 'grace_period'] as const;

@Injectable()
export class PlanSubscriberCountsService {
  constructor(private readonly tenancyContextService: TenancyContextService) {}

  /** Counts for the given plans (every plan id is present in the result). */
  async countByPlan(
    platformOwnerId: string,
    planIds: readonly string[],
    now: Date = new Date(),
  ): Promise<Map<string, PlanSubscriberCounts>> {
    const result = new Map<string, PlanSubscriberCounts>(
      planIds.map((id) => [id, ZERO_SUBSCRIBER_COUNTS]),
    );
    if (planIds.length === 0) return result;
    const ids = [...planIds];

    const [paying, trialing, scheduled, founding] =
      await this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
        Promise.all([
          tx.tenantSubscription.groupBy({
            by: ['planId'],
            where: { planId: { in: ids }, status: { in: [...PAYING_STATUSES] } },
            _count: { _all: true },
          }),
          tx.tenantSubscription.groupBy({
            by: ['planId'],
            where: { planId: { in: ids }, status: 'trialing', trialEndsAt: { gt: now } },
            _count: { _all: true },
          }),
          tx.tenantSubscription.groupBy({
            by: ['scheduledPlanId'],
            where: { scheduledPlanId: { in: ids }, scheduledChangeAt: { gt: now } },
            _count: { _all: true },
          }),
          tx.foundingMembership.groupBy({
            by: ['planId'],
            where: { planId: { in: ids }, status: 'active' },
            _count: { _all: true },
          }),
        ]),
      );

    const add = (planId: string | null, field: keyof PlanSubscriberCounts, n: number) => {
      if (!planId || !result.has(planId)) return;
      result.set(planId, { ...result.get(planId)!, [field]: n });
    };
    for (const row of paying) add(row.planId, 'paying', row._count._all);
    for (const row of trialing) add(row.planId, 'trialing', row._count._all);
    for (const row of scheduled) add(row.scheduledPlanId, 'scheduledIn', row._count._all);
    for (const row of founding) add(row.planId, 'foundingLocks', row._count._all);
    return result;
  }

  /** Counts for one plan inside an existing platform-owner transaction. */
  async countOne(
    tx: Prisma.TransactionClient,
    planId: string,
    now: Date = new Date(),
  ): Promise<PlanSubscriberCounts> {
    const [paying, trialing, scheduledIn, foundingLocks] = await Promise.all([
      tx.tenantSubscription.count({
        where: { planId, status: { in: [...PAYING_STATUSES] } },
      }),
      tx.tenantSubscription.count({
        where: { planId, status: 'trialing', trialEndsAt: { gt: now } },
      }),
      tx.tenantSubscription.count({
        where: { scheduledPlanId: planId, scheduledChangeAt: { gt: now } },
      }),
      tx.foundingMembership.count({ where: { planId, status: 'active' } }),
    ]);
    return { paying, trialing, scheduledIn, foundingLocks };
  }
}
