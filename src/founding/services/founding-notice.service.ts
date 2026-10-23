/**
 * FoundingNoticeService — B2: the Founding Academies work the subscription
 * sweep does on its existing tick (never a scheduler of its own).
 *
 * 1. ENDED. An `active` membership whose lock end has passed becomes
 *    `ended` (the seat stays taken), with an audit row. Pricing never
 *    depended on this flip — `foundingPriceFor` compares the renewal's
 *    start with `lockEndsAt` — so a late tick cannot misprice anything.
 *
 * 2. RENEWAL PRICE NOTICE. The promise on /founding: "If it is different
 *    from yours, we email you before the renewal." About 30 days before a
 *    yearly period ends (the same lead as the annual renewal reminder),
 *    when the renewal starting at that period end will NOT be at the
 *    locked price — the 24-month lock ends first, or the membership was
 *    revoked — and the catalog price it will be charged differs from the
 *    locked one, the owner gets `lifecycle.founding.renewal_price_notice`
 *    once for that renewal (`price_notice_sent_for` + the dedupe key).
 *    Only for a period that itself began inside the lock, so a customer
 *    already renewing at the catalog price is not told again each year
 *    (a later catalog edit is the existing B0-BIL-07 price-change notice).
 *    It does not depend on the lifecycle-sequence flag.
 *
 * Runs in the first Platform Owner's user context, like the sweep's other
 * cross-tenant steps. A failure for one organization is logged and the
 * rest continue.
 */
import { Injectable, Logger } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { CommunicationService } from '../../communications/services/communication.service';
import { formatNoticePrice } from '../../plans/utils/price-change-notice.util';
import { formatLifecycleInstant } from '../../plans/services/tenant-lifecycle.service';
import { planNameValues } from '../../communications/utils/plan-name-values.util';
import {
  catalogAnnualPrice,
  foundingPriceFor,
  samePrice,
  toFoundingLock,
} from '../founding-lock';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Same lead as the yearly renewal reminder (S3a). */
export const FOUNDING_RENEWAL_NOTICE_LEAD_MS = 30 * DAY_MS;

export interface FoundingSweepResult {
  readonly ended: number;
  readonly noticesSent: number;
}

@Injectable()
export class FoundingNoticeService {
  private readonly logger = new Logger(FoundingNoticeService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly usersRepository: UsersRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly communicationService: CommunicationService,
  ) {}

  async run(now: Date = new Date()): Promise<FoundingSweepResult> {
    const platformOwner = await this.usersRepository.findFirstPlatformOwnerId();
    if (!platformOwner) return { ended: 0, noticesSent: 0 };
    const ended = await this.endElapsedLocks(platformOwner.id, now);
    const noticesSent = await this.sendRenewalPriceNotices(platformOwner.id, now);
    if (ended > 0 || noticesSent > 0) {
      this.logger.log({ ended, noticesSent }, 'Founding Academies sweep step complete.');
    }
    return { ended, noticesSent };
  }

  async endElapsedLocks(actorUserId: string, now: Date): Promise<number> {
    return this.tenancyContextService.runInUserContext(actorUserId, async (tx) => {
      const due = await tx.foundingMembership.findMany({
        where: { status: 'active', lockEndsAt: { lte: now } },
        include: { organization: { select: { name: true } } },
      });
      for (const row of due) {
        await tx.foundingMembership.update({
          where: { id: row.id },
          data: { status: 'ended', updatedByUserId: actorUserId },
        });
        await this.auditLogWriterService.write(tx, {
          actorUserId,
          role: 'platform_owner',
          action: 'platform.founding.ended',
          targetType: 'founding_membership',
          targetId: row.id,
          targetLabel: row.organization.name,
          context: {
            organizationId: row.organizationId,
            seatNumber: row.seatNumber,
            lockEndsAt: row.lockEndsAt.toISOString(),
          },
        });
      }
      return due.length;
    });
  }

  async sendRenewalPriceNotices(actorUserId: string, now: Date): Promise<number> {
    const horizon = new Date(now.getTime() + FOUNDING_RENEWAL_NOTICE_LEAD_MS);
    const candidates = await this.tenancyContextService.runInUserContext(
      actorUserId,
      (tx) =>
        tx.foundingMembership.findMany({
          where: {
            organization: {
              subscription: {
                status: 'active',
                billingCycle: 'yearly',
                cancelAtPeriodEnd: false,
                currentPeriodEnd: { gt: now, lte: horizon },
              },
            },
          },
          include: {
            organization: {
              select: {
                ownerUserId: true,
                name: true,
                subscription: {
                  select: {
                    planId: true,
                    currentPeriodStart: true,
                    currentPeriodEnd: true,
                    plan: {
                      select: {
                        id: true,
                        name: true,
                        nameLocalized: true,
                        pricing: true,
                      },
                    },
                  },
                },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        }),
    );

    let sent = 0;
    const seen = new Set<string>();
    for (const row of candidates) {
      // The organization's latest membership is the one that decides.
      if (seen.has(row.organizationId)) continue;
      seen.add(row.organizationId);
      const sub = row.organization.subscription;
      const periodEnd = sub?.currentPeriodEnd;
      if (!sub || !periodEnd) continue;
      if (row.priceNoticeSentFor?.getTime() === periodEnd.getTime()) continue;

      const lock = toFoundingLock(row);
      // Only a period that began inside the lock was at the locked price.
      const periodStart = sub.currentPeriodStart ?? row.lockStartsAt;
      if (periodStart.getTime() >= lock.lockEndsAt.getTime()) continue;
      if (row.revokedAt && periodStart.getTime() >= row.revokedAt.getTime()) continue;

      const stillLocked = foundingPriceFor(lock, {
        planId: sub.planId,
        billingCycle: 'yearly',
        periodStart: periodEnd,
      });
      if (stillLocked) continue;
      const renewal = catalogAnnualPrice(sub.plan.pricing);
      const locked = { amount: lock.lockedAmount, currency: lock.lockedCurrency };
      if (!renewal || samePrice(renewal, locked)) continue;

      try {
        const periodEndAt = periodEnd.toISOString();
        const emitted = await this.tenancyContextService.runInUserContext(
          actorUserId,
          async (tx) => {
            await tx.foundingMembership.update({
              where: { id: row.id },
              data: { priceNoticeSentFor: periodEnd },
            });
            await this.auditLogWriterService.write(tx, {
              actorUserId,
              role: 'platform_owner',
              action: 'platform.founding.renewal_price_notice_sent',
              targetType: 'founding_membership',
              targetId: row.id,
              targetLabel: row.organization.name,
              context: {
                organizationId: row.organizationId,
                periodEndAt,
                renewalAmount: renewal.amount,
                lockedAmount: locked.amount,
                currency: renewal.currency,
              },
            });
            return this.communicationService.emit(tx, {
              key: 'lifecycle.founding.renewal_price_notice',
              recipientUserId: row.organization.ownerUserId,
              organizationId: row.organizationId,
              entity: { type: 'founding_membership', id: row.id },
              values: {
                periodEndAt,
                ...planNameValues(sub.plan),
                lockedPrice: formatNoticePrice(locked),
                renewalPrice: formatNoticePrice(renewal),
                lockEndDate: formatLifecycleInstant(
                  row.revokedAt && row.revokedAt < lock.lockEndsAt
                    ? periodEnd
                    : lock.lockEndsAt,
                ),
                renewalDate: formatLifecycleInstant(periodEnd),
              },
            });
          },
        );
        await this.communicationService.enqueueAfterCommit(emitted.outboxId);
        sent += 1;
      } catch (error) {
        this.logger.error(
          `founding renewal notice failed for organization ${row.organizationId}: ${(error as Error).message}`,
        );
      }
    }
    return sent;
  }
}
