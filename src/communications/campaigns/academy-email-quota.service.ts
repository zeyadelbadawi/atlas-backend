/**
 * W3-compose — the per-academy monthly email quota (W3b C.2).
 *
 *   LIMIT   `monthlyEmails` from the organization's subscription: the
 *           granted snapshot, else the live plan, else 50
 *           (`DEFAULT_MONTHLY_EMAILS`) — never "unlimited" by omission —
 *           plus any entitling add-on that raises it, through the one
 *           `EntitlementService.computeEffectiveEntitlements` formula.
 *   SCOPE   per academy (`tenant_email_usage_periods` keyed by academy).
 *   PERIOD  the calendar month in UTC; the row is created lazily by the
 *           first reservation of the month, so nothing has to roll over.
 *   COUNT   one unit per EMAIL outbox row actually created. In-app
 *           notifications and Platform Owner campaigns never touch it.
 *
 * CONCURRENCY. `reserve` is ONE conditional UPDATE —
 *
 *     UPDATE tenant_email_usage_periods
 *        SET used = used + n
 *      WHERE academy_id = $a AND period_start = $p
 *        AND ($limit IS NULL OR used + n <= $limit)
 *
 * — run in the SAME transaction that creates the campaign. Postgres
 * row-locks the period row for the UPDATE; a concurrent reservation waits,
 * then re-evaluates the WHERE against the committed `used` (READ
 * COMMITTED's re-check), so N parallel sends can never push `used` past
 * the limit. Zero rows updated = refused; nothing is half-applied, because
 * the caller's transaction then throws and rolls the campaign back too.
 *
 * LEDGER. Every movement writes one `tenant_email_usage_ledger` row with
 * UNIQUE(message_id, kind) — `charge` at send, `release` for reserved
 * units the release step did not use, `refund` for rows that terminally
 * failed without provider acceptance — so no step can move the counter
 * twice for one message, however often it is retried.
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { EntitlementService } from '../../plans/services/entitlement.service';
import { TenantSubscriptionsRepository } from '../../plans/repositories/tenant-subscriptions.repository';
import { TenantAddOnsRepository } from '../../plans/repositories/tenant-add-ons.repository';
import { resolveSubscriptionLimits } from '../../plans/utils/granted-limits.util';
import type {
  EntitlementAddOnInput,
  LimitValue,
} from '../../plans/dto/entitlement.types';
import { DEFAULT_MONTHLY_EMAILS, type CampaignQuotaView } from './campaign.types';

export interface UsagePeriod {
  readonly start: Date;
  /** Exclusive: the first instant of the next month (UTC). */
  readonly end: Date;
}

/** The calendar month (UTC) containing `now`. */
export function emailUsagePeriod(now: Date): UsagePeriod {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

/**
 * `monthlyEmails` for one subscription: granted snapshot → live plan → 50.
 * A key ABSENT from a pre-existing `granted_limits` snapshot is "no grant
 * recorded for this capacity", which follows the catalog exactly like a
 * NULL snapshot does — and a catalog without the key gets the platform
 * default, never unlimited.
 */
export function resolveMonthlyEmailLimit(
  granted: unknown,
  planLimits: unknown,
): LimitValue {
  const pick = (source: unknown): LimitValue | undefined => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
    const value = (source as Record<string, unknown>).monthlyEmails;
    if (value === 'unlimited') return 'unlimited';
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
    return undefined;
  };
  return pick(granted) ?? pick(planLimits) ?? DEFAULT_MONTHLY_EMAILS;
}

export class AcademyEmailQuotaExceededError extends Error {
  constructor(
    readonly requested: number,
    readonly remaining: number,
    readonly limit: number | null,
  ) {
    super('Academy monthly email quota exceeded.');
    this.name = 'AcademyEmailQuotaExceededError';
  }
}

@Injectable()
export class AcademyEmailQuotaService {
  constructor(
    private readonly entitlements: EntitlementService,
    private readonly subscriptions: TenantSubscriptionsRepository,
    private readonly addOns: TenantAddOnsRepository,
  ) {}

  /** The effective monthly limit (`null` = unlimited) — read in the caller's tenant transaction. */
  async limitFor(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<number | null> {
    const subscription = await this.subscriptions.findByOrganizationId(
      tx,
      organizationId,
    );
    if (!subscription) return DEFAULT_MONTHLY_EMAILS;
    const base = resolveMonthlyEmailLimit(
      subscription.grantedLimits,
      subscription.plan.limits,
    );
    const tenantAddOns = await this.addOns.findManyForOrganization(tx, organizationId);
    const addOnInputs: EntitlementAddOnInput[] = tenantAddOns.map((tenantAddOn) => ({
      effect: tenantAddOn.addOn.effect as unknown as EntitlementAddOnInput['effect'],
      compatiblePlanKeys: tenantAddOn.addOn.compatiblePlanKeys,
    }));
    const effective = this.entitlements.computeEffectiveEntitlements(
      organizationId,
      {
        key: subscription.plan.key,
        limits: {
          ...resolveSubscriptionLimits(subscription),
          monthlyEmails: base,
        } as never,
        features: subscription.plan.features as never,
      },
      addOnInputs,
    );
    const value = effective.limits.monthlyEmails ?? base;
    return value === 'unlimited' ? null : value;
  }

  /** Current usage for the composer's meter. Never creates the period row. */
  async view(
    tx: Prisma.TransactionClient,
    organizationId: string,
    academyId: string,
    now = new Date(),
  ): Promise<CampaignQuotaView> {
    const period = emailUsagePeriod(now);
    const [limit, row] = await Promise.all([
      this.limitFor(tx, organizationId),
      tx.tenantEmailUsagePeriod.findUnique({
        where: { academyId_periodStart: { academyId, periodStart: period.start } },
        select: { used: true },
      }),
    ]);
    return toView(limit, row?.used ?? 0, period);
  }

  /**
   * Reserves `quantity` units for `messageId` or throws
   * `AcademyEmailQuotaExceededError` — never a partial reservation.
   * MUST run inside the transaction that creates the message.
   */
  async reserve(
    tx: Prisma.TransactionClient,
    input: {
      readonly organizationId: string;
      readonly academyId: string;
      readonly messageId: string;
      readonly quantity: number;
      readonly actorUserId: string;
      readonly now?: Date;
    },
  ): Promise<CampaignQuotaView> {
    const period = emailUsagePeriod(input.now ?? new Date());
    const limit = await this.limitFor(tx, input.organizationId);

    // Lazily open the month. A plain INSERT inside a savepoint-free
    // ON CONFLICT DO NOTHING: the tenant SELECT policy admits the
    // conflicting row (same organization), so conflict detection is legal.
    await tx.$executeRaw`
      INSERT INTO "tenant_email_usage_periods"
        ("academy_id", "organization_id", "period_start", "period_end", "limit_snapshot", "used", "updated_at")
      VALUES (${input.academyId}, ${input.organizationId}, ${period.start}, ${period.end},
              ${limit}, 0, now())
      ON CONFLICT ("academy_id", "period_start") DO NOTHING
    `;

    if (input.quantity > 0) {
      const updated = await tx.$queryRaw<{ used: number }[]>`
        UPDATE "tenant_email_usage_periods"
           SET "used" = "used" + ${input.quantity},
               "limit_snapshot" = ${limit},
               "updated_at" = now()
         WHERE "academy_id" = ${input.academyId}
           AND "period_start" = ${period.start}
           AND (${limit}::int IS NULL OR "used" + ${input.quantity} <= ${limit}::int)
        RETURNING "used"
      `;
      if (updated.length === 0) {
        const current = await tx.tenantEmailUsagePeriod.findUnique({
          where: {
            academyId_periodStart: {
              academyId: input.academyId,
              periodStart: period.start,
            },
          },
          select: { used: true },
        });
        const used = current?.used ?? 0;
        throw new AcademyEmailQuotaExceededError(
          input.quantity,
          limit === null ? Number.MAX_SAFE_INTEGER : Math.max(0, limit - used),
          limit,
        );
      }
      await this.writeLedger(tx, {
        organizationId: input.organizationId,
        academyId: input.academyId,
        periodStart: period.start,
        messageId: input.messageId,
        kind: 'charge',
        quantity: input.quantity,
        createdBy: input.actorUserId,
      });
      return toView(limit, updated[0].used, period);
    }

    const row = await tx.tenantEmailUsagePeriod.findUnique({
      where: {
        academyId_periodStart: { academyId: input.academyId, periodStart: period.start },
      },
      select: { used: true },
    });
    return toView(limit, row?.used ?? 0, period);
  }

  /**
   * Gives back `quantity` units of a message's charge (`release`: reserved
   * but not used; `refund`: failed with no provider acceptance). Idempotent
   * per (message, kind): a second call for the same pair changes nothing.
   * Runs under the Platform Owner context (the campaign worker).
   */
  async giveBack(
    tx: Prisma.TransactionClient,
    input: {
      readonly organizationId: string;
      readonly academyId: string;
      readonly periodStart: Date;
      readonly messageId: string;
      readonly kind: 'release' | 'refund';
      readonly quantity: number;
    },
  ): Promise<boolean> {
    if (input.quantity <= 0) return false;
    const inserted = await this.writeLedger(tx, { ...input, createdBy: null });
    if (!inserted) return false;
    await tx.$executeRaw`
      UPDATE "tenant_email_usage_periods"
         SET "used" = GREATEST("used" - ${input.quantity}, 0),
             "updated_at" = now()
       WHERE "academy_id" = ${input.academyId}
         AND "period_start" = ${input.periodStart}
    `;
    return true;
  }

  /** `true` when the row was written, `false` when (message, kind) already existed. */
  private async writeLedger(
    tx: Prisma.TransactionClient,
    input: {
      readonly organizationId: string;
      readonly academyId: string;
      readonly periodStart: Date;
      readonly messageId: string;
      readonly kind: 'charge' | 'release' | 'refund';
      readonly quantity: number;
      readonly createdBy: string | null;
    },
  ): Promise<boolean> {
    const written = await tx.$executeRaw`
      INSERT INTO "tenant_email_usage_ledger"
        ("id", "organization_id", "academy_id", "period_start", "message_id", "kind",
         "quantity", "created_by", "created_at")
      VALUES (${randomUUID()}, ${input.organizationId}, ${input.academyId}, ${input.periodStart},
              ${input.messageId}, ${input.kind}, ${input.quantity}, ${input.createdBy}, now())
      ON CONFLICT ("message_id", "kind") DO NOTHING
    `;
    return written === 1;
  }
}

function toView(
  limit: number | null,
  used: number,
  period: UsagePeriod,
): CampaignQuotaView {
  return {
    limit,
    used,
    remaining: limit === null ? null : Math.max(0, limit - used),
    periodStart: period.start.toISOString(),
    resetsAt: period.end.toISOString(),
  };
}
