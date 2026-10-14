/**
 * PlatformSubscriptionAdjustmentsService — B0-BIL-06: the Platform Owner's
 * audited remedies on one organization's subscription, so founding price
 * locks, design-partner pilots, goodwill and support-handled plan changes
 * never need a direct database edit.
 *
 * Three actions, each with a written reason and one audit row written in
 * the same transaction as the change:
 *
 * - EXTEND (`subscription.extended_by_platform`) and GRANT DAYS
 *   (`subscription.days_granted_by_platform`) move the date the customer's
 *   access runs to: `trialEndsAt` while trialing, `currentPeriodEnd`
 *   otherwise. They differ only in what they are FOR (a correction versus
 *   a goodwill gift), which is why they are separate audit actions: a
 *   report of goodwill given must not have to parse reasons. Neither
 *   touches the W8 gifted-days columns, which record the one gift of a
 *   first paid subscription and are write-once by design.
 *   The new date counts from the later of the current end and now, so
 *   extending a lapsed trial or period by 10 days gives 10 days of access,
 *   not 10 days after a date already past. A grace-period row returns to
 *   `active`. Expired and cancelled rows are refused: bringing those back
 *   is a plan change or a payment, not an extension.
 *
 * - CHANGE PLAN (`subscription.plan_changed_by_platform`) moves the
 *   organization to any non-archived plan, hidden plans included (founding
 *   locks are hidden plans, B0-BIL-11), and re-grants that plan's CURRENT
 *   limits. `now` applies at once and drops any scheduled change;
 *   `period_end` schedules it for the end of the current paid period
 *   through the same columns and sweep as a customer's own downgrade
 *   (B0-BIL-04).
 *
 * CONTEXT. Runs in the organization's tenant context AND the Platform
 * Owner's user context (`runInTenantAndUserContext`), the same pairing
 * payment approval uses: the subscription row is written under the
 * policies that already govern it, never with RLS switched off. Who may
 * call is decided by `PlatformOwnerGuard` on the controller.
 *
 * Reversal is the opposite action: change the plan back, or extend the
 * other way by changing the plan/period through a payment. Negative days
 * are refused by the DTO.
 */
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Plan, TenantSubscription } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { TenantSubscriptionsRepository } from '../../plans/repositories/tenant-subscriptions.repository';
import { limitsToGrant } from '../../plans/utils/granted-limits.util';
import { toTenantSubscriptionResponse } from '../../plans/dto/tenant-subscription.contract';
import type { TenantSubscriptionResponse } from '../../plans/dto/tenant-subscription.contract';
import { PLANS_CLOCK, type Clock } from '../../plans/utils/clock';
import type { PlanChangeApplyAt } from '../dto/subscription-adjustment.dto';

const DAY_MS = 24 * 60 * 60 * 1000;

export type DaysAdjustmentKind = 'extend' | 'grant';

const DAYS_ACTION: Record<DaysAdjustmentKind, string> = {
  extend: 'subscription.extended_by_platform',
  grant: 'subscription.days_granted_by_platform',
};

/** Statuses whose access date an extension can move. */
const EXTENDABLE = new Set<TenantSubscription['status']>([
  'trialing',
  'active',
  'grace_period',
]);

@Injectable()
export class PlatformSubscriptionAdjustmentsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly tenantSubscriptionsRepository: TenantSubscriptionsRepository,
    @Inject(PLANS_CLOCK) private readonly clock: Clock,
  ) {}

  async adjustDays(
    platformOwnerId: string,
    organizationId: string,
    kind: DaysAdjustmentKind,
    input: { readonly days: number; readonly reason: string },
  ): Promise<TenantSubscriptionResponse> {
    const now = this.clock.now();
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      platformOwnerId,
      async (tx) => {
        const current = await this.lockAndRead(tx, organizationId);
        if (!EXTENDABLE.has(current.status)) {
          throw new ConflictException({
            messageKey: 'errors.platform.subscriptionAdjustment.notExtendable',
          });
        }

        const trialing = current.status === 'trialing';
        const field = trialing ? 'trialEndsAt' : 'currentPeriodEnd';
        const from = trialing ? current.trialEndsAt : current.currentPeriodEnd;
        const base = from && from.getTime() > now.getTime() ? from : now;
        const to = new Date(base.getTime() + input.days * DAY_MS);

        await tx.tenantSubscription.update({
          where: { organizationId },
          data: trialing
            ? { trialEndsAt: to }
            : { currentPeriodEnd: to, status: 'active', graceEndsAt: null },
        });

        await this.auditLogWriterService.write(tx, {
          actorUserId: platformOwnerId,
          organizationId,
          role: 'platform_owner',
          action: DAYS_ACTION[kind],
          targetType: 'tenant_subscription',
          targetId: organizationId,
          context: {
            days: input.days,
            reason: input.reason,
            field,
            previousStatus: current.status,
          },
          changes: {
            [field]: { from: from?.toISOString() ?? null, to: to.toISOString() },
            ...(current.status === 'grace_period'
              ? { status: { from: 'grace_period', to: 'active' } }
              : {}),
          },
        });

        return this.read(tx, organizationId);
      },
    );
  }

  async changePlan(
    platformOwnerId: string,
    organizationId: string,
    input: {
      readonly planKey: string;
      readonly applyAt: PlanChangeApplyAt;
      readonly reason: string;
    },
  ): Promise<TenantSubscriptionResponse> {
    const now = this.clock.now();
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      platformOwnerId,
      async (tx) => {
        const current = await this.lockAndRead(tx, organizationId);
        const plan = await tx.plan.findUnique({ where: { key: input.planKey } });
        if (!plan) throw new NotFoundException({ messageKey: 'errors.notFound' });
        if (plan.status === 'archived') {
          throw new ConflictException({
            messageKey: 'errors.platform.subscriptionAdjustment.planArchived',
          });
        }

        let effectiveAt: Date;
        if (input.applyAt === 'now') {
          effectiveAt = now;
          await tx.tenantSubscription.update({
            where: { organizationId },
            data: {
              planId: plan.id,
              grantedLimits: limitsToGrant(plan) as unknown as Prisma.InputJsonValue,
              scheduledPlanId: null,
              scheduledGrantedLimits: Prisma.DbNull,
              scheduledChangeAt: null,
            },
          });
        } else {
          const periodEnd = current.currentPeriodEnd;
          if (
            current.status !== 'active' ||
            !periodEnd ||
            periodEnd.getTime() <= now.getTime()
          ) {
            throw new ConflictException({
              messageKey: 'errors.platform.subscriptionAdjustment.noPaidPeriod',
            });
          }
          effectiveAt = periodEnd;
          await tx.tenantSubscription.update({
            where: { organizationId },
            data: {
              scheduledPlanId: plan.id,
              scheduledGrantedLimits: limitsToGrant(
                plan,
              ) as unknown as Prisma.InputJsonValue,
              scheduledChangeAt: periodEnd,
            },
          });
        }

        await this.auditLogWriterService.write(tx, {
          actorUserId: platformOwnerId,
          organizationId,
          role: 'platform_owner',
          action: 'subscription.plan_changed_by_platform',
          targetType: 'tenant_subscription',
          targetId: organizationId,
          context: {
            fromPlanId: current.planId,
            toPlanId: plan.id,
            toPlanKey: plan.key,
            applyAt: input.applyAt,
            effectiveAt: effectiveAt.toISOString(),
            reason: input.reason,
          },
        });

        return this.read(tx, organizationId);
      },
    );
  }

  private async lockAndRead(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<TenantSubscription & { plan: Plan }> {
    // Serialises against a payment approval or another adjustment on the
    // same row, so two writers never compute from the same stale dates.
    await this.tenantSubscriptionsRepository.lockForPurchase(tx, organizationId);
    const row = await tx.tenantSubscription.findUnique({
      where: { organizationId },
      include: { plan: true },
    });
    if (!row) {
      throw new NotFoundException({ messageKey: 'errors.tenant.noSubscription' });
    }
    return row;
  }

  private async read(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<TenantSubscriptionResponse> {
    const row = await tx.tenantSubscription.findUniqueOrThrow({
      where: { organizationId },
      include: { plan: true },
    });
    const scheduledPlanName = row.scheduledPlanId
      ? ((await this.tenantSubscriptionsRepository.findPlanName(
          tx,
          row.scheduledPlanId,
        )) ?? undefined)
      : undefined;
    return toTenantSubscriptionResponse(row, undefined, scheduledPlanName);
  }
}
