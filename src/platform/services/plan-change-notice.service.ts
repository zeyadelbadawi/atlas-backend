/**
 * PlanChangeNoticeService — B0-BIL-07: tells existing subscribers, before
 * it applies to them, that the plan they renew into changed.
 *
 * WHY THIS IS NEEDED. Renewal is a new checkout priced from the live plan
 * row, and it re-grants the plan's current limits
 * (`PaymentApplicationService`). A Platform Owner's edit to a plan's price
 * or limits therefore reaches every paying customer on that plan at their
 * next renewal, and Terms §9 promises them notice in the product first.
 * Until this service existed the only trace of such an edit was the
 * `plan.pricing_changed` audit row.
 *
 * WHO IS TOLD. Organisations whose subscription is `active` or
 * `grace_period` and whose NEXT plan is the edited one: the current plan
 * when nothing is scheduled, or the scheduled plan when a downgrade is
 * waiting for the period end (B0-BIL-04). Trials are not told — they have
 * paid nothing, and the plans page already shows the live price they would
 * convert at. Each organisation's OWNER receives one email + in-app
 * notice, and the subscription row carries the notice for the banner.
 *
 * WHAT THEY ARE TOLD is computed per subscriber by
 * `buildPriceChangeNotice`: the renewal price for THEIR billing cycle
 * before and after, and each limit that will differ from what they hold.
 * An edit that changes nothing for a given subscriber (say, only the
 * yearly price, for a monthly customer) tells them nothing.
 *
 * ONE TRANSACTION PER ORGANISATION, AFTER THE PLAN EDIT COMMITS. The plan
 * edit stays small and fast whatever the subscriber count; a failure for
 * one organisation is logged and counted, never rolls back the price or
 * the other notices. Re-running for the same plan version is harmless:
 * the email dedupe key carries the plan version, and the row write is a
 * plain overwrite with the same content. The totals are written to the
 * audit log (`plan.subscribers_notified`) so the Platform Owner has a
 * record of who was notified, which is what the record's acceptance
 * criteria ask for.
 *
 * CONTEXT. Runs under the acting Platform Owner's user context, never
 * `runWithoutContext`, so every read and write stays policy-bound
 * (`tenant_subscriptions_platform_select`/`_platform_update`, and the
 * system insert policies `CommunicationService.emit` relies on) — the
 * same precedent `TenantLifecycleService` follows.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { CommunicationService } from '../../communications/services/communication.service';
import { formatLifecycleInstant } from '../../plans/services/tenant-lifecycle.service';
import {
  buildPriceChangeNotice,
  formatNoticePrice,
  readPriceChangeNotice,
  renewalCycleFor,
} from '../../plans/utils/price-change-notice.util';
import { planNameValues } from '../../communications/utils/plan-name-values.util';

/** Subscribers read per page — bounded so one huge plan never loads at once. */
const PAGE_SIZE = 200;

export interface PlanChangeSnapshot {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly version: number;
  readonly pricing: unknown;
  readonly limits: unknown;
}

export interface PlanChangeNoticeResult {
  readonly notified: number;
  readonly cleared: number;
  readonly unchanged: number;
  readonly failed: number;
}

interface SubscriberRow {
  readonly organizationId: string;
  readonly status: string;
  readonly planId: string;
  readonly billingCycle: 'monthly' | 'yearly' | null;
  readonly grantedLimits: Prisma.JsonValue;
  readonly scheduledPlanId: string | null;
  readonly scheduledGrantedLimits: Prisma.JsonValue;
  readonly currentPeriodEnd: Date | null;
  readonly priceChangeNotice: Prisma.JsonValue;
  readonly organization: { readonly ownerUserId: string } | null;
}

@Injectable()
export class PlanChangeNoticeService {
  private readonly logger = new Logger(PlanChangeNoticeService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly communicationService: CommunicationService,
  ) {}

  async notifySubscribers(
    platformOwnerId: string,
    before: PlanChangeSnapshot,
    after: PlanChangeSnapshot,
    now: Date = new Date(),
  ): Promise<PlanChangeNoticeResult> {
    let notified = 0;
    let cleared = 0;
    let unchanged = 0;
    let failed = 0;
    let cursor: string | undefined;

    for (;;) {
      const page = await this.tenancyContextService.runInUserContext(
        platformOwnerId,
        (tx) =>
          tx.tenantSubscription.findMany({
            where: {
              status: { in: ['active', 'grace_period'] },
              OR: [
                { scheduledPlanId: after.id },
                { planId: after.id, scheduledPlanId: null },
              ],
            },
            select: {
              organizationId: true,
              status: true,
              planId: true,
              billingCycle: true,
              grantedLimits: true,
              scheduledPlanId: true,
              scheduledGrantedLimits: true,
              currentPeriodEnd: true,
              priceChangeNotice: true,
              organization: { select: { ownerUserId: true } },
            },
            orderBy: { organizationId: 'asc' },
            take: PAGE_SIZE,
            ...(cursor ? { cursor: { organizationId: cursor }, skip: 1 } : {}),
          }),
      );
      if (page.length === 0) break;

      for (const row of page as SubscriberRow[]) {
        try {
          const outcome = await this.noticeOne(platformOwnerId, row, before, after, now);
          if (outcome === 'notified') notified += 1;
          else if (outcome === 'cleared') cleared += 1;
          else unchanged += 1;
        } catch (error) {
          failed += 1;
          this.logger.error(
            `plan change notice failed for organization ${row.organizationId}: ${(error as Error).message}`,
          );
        }
      }

      if (page.length < PAGE_SIZE) break;
      cursor = page[page.length - 1].organizationId;
    }

    await this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
      this.auditLogWriterService.write(tx, {
        actorUserId: platformOwnerId,
        action: 'plan.subscribers_notified',
        targetType: 'plan',
        targetId: after.id,
        targetLabel: after.name,
        context: {
          key: after.key,
          planVersion: after.version,
          notified,
          cleared,
          failed,
        },
      }),
    );

    return { notified, cleared, unchanged, failed };
  }

  private async noticeOne(
    platformOwnerId: string,
    row: SubscriberRow,
    before: PlanChangeSnapshot,
    after: PlanChangeSnapshot,
    now: Date,
  ): Promise<'notified' | 'cleared' | 'unchanged'> {
    const scheduled = row.scheduledPlanId === after.id;
    // What the subscriber holds for the plan they renew into. A row with
    // no recorded grant follows the live catalog, so a limit edit has
    // ALREADY reached it — there is no future limit change to announce.
    const currentLimits = scheduled
      ? row.scheduledGrantedLimits
      : (row.grantedLimits ?? after.limits);
    const pending = readPriceChangeNotice(row.priceChangeNotice);
    const notice = buildPriceChangeNotice({
      planId: after.id,
      planVersion: after.version,
      billingCycle: renewalCycleFor(row.billingCycle, after.pricing),
      previousPricing: before.pricing,
      nextPricing: after.pricing,
      currentLimits,
      nextLimits: after.limits,
      pending,
      noticedAt: now,
    });

    if (!notice) {
      if (!pending || pending.planId !== after.id) return 'unchanged';
      // A later edit put back everything this customer was told about.
      await this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
        tx.tenantSubscription.update({
          where: { organizationId: row.organizationId },
          data: { priceChangeNotice: Prisma.DbNull, priceChangeNoticeDismissedAt: null },
        }),
      );
      return 'cleared';
    }

    // A grace-period row's paid period has already ended: its "next
    // renewal" is whenever it pays, so no date is promised.
    const renewalDate =
      row.status === 'active' && row.currentPeriodEnd
        ? formatLifecycleInstant(row.currentPeriodEnd)
        : '';

    const emitted = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      async (tx) => {
        await tx.tenantSubscription.update({
          where: { organizationId: row.organizationId },
          data: {
            priceChangeNotice: notice as unknown as Prisma.InputJsonValue,
            // A new notice is shown again even if an older one was dismissed.
            priceChangeNoticeDismissedAt: null,
          },
        });
        if (!row.organization) return { created: false, outboxId: null };
        return this.communicationService.emit(tx, {
          key: 'lifecycle.subscription.price_change_notice',
          recipientUserId: row.organization.ownerUserId,
          organizationId: row.organizationId,
          entity: { type: 'tenant_subscription', id: row.organizationId },
          values: {
            ...planNameValues(after),
            planVersion: String(after.version),
            fromPrice: formatNoticePrice(notice.fromPrice),
            toPrice: formatNoticePrice(notice.toPrice),
            renewalDate,
            limitChangeCount: Object.keys(notice.limitChanges).length,
          },
        });
      },
    );
    await this.communicationService.enqueueAfterCommit(emitted.outboxId);
    return 'notified';
  }
}
