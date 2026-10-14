/**
 * B0-BIL-13 — tells the organization owner when a plan limit is close
 * (80 %) or reached (100 %). Limits are hard on create (409), and caps are
 * the only pricing fence, so without a warning an owner first learns about
 * a limit when a learner cannot enrol.
 *
 * Runs after each usage recompute (`TenantUsageRecomputeProcessor`), which
 * follows usage-changing writes and the periodic sweep, against the same
 * effective limits the write gate enforces (`TenantSubscriptionService.
 * getUsage`). One notification per limit, threshold and billing period
 * (the catalogue dedupe carries the period), in-app + email, linking to
 * the plans page. Best-effort: a failure here never fails the recompute.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { CommunicationService } from '../../communications/services/communication.service';
import { TenantSubscriptionService } from './tenant-subscription.service';
import type { UsageMetricResponse } from '../dto/tenant-usage.contract';

/** The limits customers see (B0-MED-04 hides video while it is unusable). */
export const WARNED_LIMIT_KEYS = [
  'students',
  'courses',
  'academies',
  'generalStorage',
] as const;

export type WarnedLimitKey = (typeof WARNED_LIMIT_KEYS)[number];

export const APPROACHING_RATIO = 0.8;

/** `reached` at or over the limit, `approaching` from 80 %, else nothing. */
export function limitThreshold(
  metric: Pick<UsageMetricResponse, 'used' | 'limit'>,
): 'approaching' | 'reached' | null {
  if (typeof metric.limit !== 'number' || metric.limit <= 0) return null;
  if (metric.used >= metric.limit) return 'reached';
  if (metric.used >= metric.limit * APPROACHING_RATIO) return 'approaching';
  return null;
}

function formatAmount(key: WarnedLimitKey, value: number): string {
  // Storage is in GB with fractions; counts are whole numbers.
  return key === 'generalStorage'
    ? String(Math.round(value * 10) / 10)
    : String(Math.round(value));
}

@Injectable()
export class UsageLimitWarningService {
  private readonly logger = new Logger(UsageLimitWarningService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly tenantSubscriptionService: TenantSubscriptionService,
    private readonly communicationService: CommunicationService,
  ) {}

  async checkAndNotify(organizationId: string): Promise<void> {
    try {
      let usage;
      try {
        usage = await this.tenantSubscriptionService.getUsage(organizationId);
      } catch (error) {
        // No subscription or no usage row yet: nothing to compare against.
        if (error instanceof NotFoundException) return;
        throw error;
      }

      const crossings = WARNED_LIMIT_KEYS.flatMap((key) => {
        const threshold = limitThreshold(usage[key]);
        return threshold ? [{ key, threshold, metric: usage[key] }] : [];
      });
      if (crossings.length === 0) return;

      const outboxIds = await this.tenancyContextService.runInTenantContext(
        organizationId,
        async (tx) => {
          const [organization, subscription] = await Promise.all([
            tx.organization.findUnique({
              where: { id: organizationId },
              select: { ownerUserId: true },
            }),
            tx.tenantSubscription.findUnique({
              where: { organizationId },
              select: { currentPeriodStart: true, createdAt: true },
            }),
          ]);
          if (!organization) return [];
          // The billing period the warning belongs to: a new period may warn
          // again; the same period never twice.
          const periodStart =
            subscription?.currentPeriodStart ?? subscription?.createdAt ?? new Date();
          const periodKey = periodStart.toISOString().slice(0, 10);
          const ids: (string | null)[] = [];
          for (const crossing of crossings) {
            const emitted = await this.communicationService.emit(tx, {
              key:
                crossing.threshold === 'reached'
                  ? 'billing.limit.reached'
                  : 'billing.limit.approaching',
              recipientUserId: organization.ownerUserId,
              organizationId,
              entity: { type: 'organization', id: organizationId },
              values: {
                limitKey: crossing.key,
                used: formatAmount(crossing.key, crossing.metric.used),
                limit: formatAmount(crossing.key, crossing.metric.limit as number),
                periodKey,
              },
            });
            ids.push(emitted.outboxId);
          }
          return ids;
        },
      );
      for (const outboxId of outboxIds) {
        await this.communicationService.enqueueAfterCommit(outboxId);
      }
    } catch (error) {
      this.logger.warn(
        { organizationId, error: error instanceof Error ? error.message : String(error) },
        'Could not check plan limits for usage warnings.',
      );
    }
  }
}
