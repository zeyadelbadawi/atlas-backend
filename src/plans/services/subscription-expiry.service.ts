/**
 * SubscriptionExpiryService — Phase 2 (Decision 6), extended by the
 * expiry enforcement. The one place a subscription row is physically
 * transitioned by the clock:
 *
 *   `expireDueTrials`       trialing     -> trial_expired
 *   `expireDuePaidPeriods`  active       -> grace_period  (graceEndsAt set)
 *                           active       -> cancelled     (cancelAtPeriodEnd)
 *                           grace_period -> expired
 *
 * "must transition automatically and reliably ... no manual intervention"
 * (roadmap §1, Decision 6). Before `expireDuePaidPeriods` existed the paid
 * half of this table had NO writer: nothing read `currentPeriodEnd`,
 * `cancelAtPeriodEnd` was recorded and never acted on, and `grace_period`
 * was never entered — a paid subscription simply never ended.
 *
 * THE SWEEP IS NOT WHAT ENFORCES. Every access decision already derives the
 * same transitions live from `resolveEffectiveSubscriptionStatus`; this
 * service makes them DURABLE and VISIBLE (the Subscription page, a plain
 * `GET`, the platform organizations list) and emits the audit trail and
 * cache invalidation that a purely derived state cannot. What it persists
 * is exactly what that pure function says, so the two can never disagree.
 *
 * Runs under the Platform Owner's own RLS bypass
 * (`runInUserContext(<a real platform-owner id>)`), the exact same
 * mechanism every other genuinely cross-tenant Platform Owner read/write
 * in this codebase already uses (`PlatformOrganizationsService`,
 * `PlatformProvisioningService`) — never a second, parallel "system"
 * bypass. `UsersRepository.findFirstPlatformOwnerId` resolves which real
 * user id to run under; if none exists yet (a schema freshly migrated but
 * never seeded/bootstrapped), the sweep logs a warning and does nothing
 * rather than crash the scheduler — there is no organization able to be
 * expired if the platform itself has no owner account yet either.
 *
 * Both methods are directly callable — by `SubscriptionSweepService` (the
 * real, scheduled, production path) AND by tests, which either seed dates
 * already in the past or move the injected `Clock` and call them directly
 * rather than actually waiting or manipulating the system clock (the
 * "controlled/fast-forwarded clock" the roadmap's own testing section
 * asks for).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TenantSubscription } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { PublicWebsiteCacheService } from '../../public-website/services/public-website-cache.service';
import { TenantSubscriptionsRepository } from '../repositories/tenant-subscriptions.repository';
import { resolveEffectiveSubscriptionStatus } from '../utils/subscription-effective-status.util';
import { PLANS_CLOCK, type Clock } from '../utils/clock';
import { SUBSCRIPTION_SWEEP_QUERY_PAGE_SIZE } from '../queue/subscription-sweep.types';

/** Audit actions the paid-period sweep writes — one per transition, named for what happened to the customer. */
export const SUBSCRIPTION_EXPIRY_AUDIT_ACTIONS = {
  graceStarted: 'subscription.grace_started',
  expired: 'subscription.expired',
  cancelledAtPeriodEnd: 'subscription.cancelled_at_period_end',
} as const;

export interface PaidPeriodSweepResult {
  readonly graceStarted: number;
  readonly cancelled: number;
  readonly expired: number;
}

@Injectable()
export class SubscriptionExpiryService {
  private readonly logger = new Logger(SubscriptionExpiryService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly usersRepository: UsersRepository,
    private readonly tenantSubscriptionsRepository: TenantSubscriptionsRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly publicWebsiteCacheService: PublicWebsiteCacheService,
    @Inject(PLANS_CLOCK) private readonly clock: Clock,
  ) {}

  /** Returns the number of subscriptions actually transitioned, for logging/test assertions. */
  async expireDueTrials(now: Date = this.clock.now()): Promise<number> {
    const platformOwner = await this.usersRepository.findFirstPlatformOwnerId();
    if (!platformOwner) {
      this.logger.warn(
        'No platform owner account exists yet — skipping trial-expiry sweep.',
      );
      return 0;
    }

    const due = await this.tenancyContextService.runInUserContext(
      platformOwner.id,
      (tx) => this.tenantSubscriptionsRepository.findManyDueForTrialExpiry(tx, now),
    );

    for (const subscription of due) {
      // `markTrialExpired`, not `markExpired` (Phase 11): what ran out
      // here is a TRIAL, and the row must keep saying so. The old call
      // flattened these into the same `expired` a lapsed payer gets and
      // nulled `trialEndsAt` on the way, leaving the recovery screen with
      // nothing specific to offer.
      await this.tenancyContextService.runInUserContext(platformOwner.id, (tx) =>
        this.tenantSubscriptionsRepository.markTrialExpired(
          tx,
          subscription.organizationId,
        ),
      );
    }

    if (due.length > 0) {
      this.logger.log({ count: due.length }, 'Expired due trial subscriptions.');
    }

    return due.length;
  }

  /**
   * Persists every PAID-period transition that is due at `now`.
   *
   * Two cursor-paginated scans (page size shared with the usage sweep):
   * `active` rows past `currentPeriodEnd`, then `grace_period` rows past
   * `graceEndsAt`. Each row's destination comes from
   * `resolveEffectiveSubscriptionStatus`, and each write is a guarded
   * `updateMany` that only applies if the row is still in the state it
   * was read in — so running this twice, or concurrently with a renewal,
   * transitions each row at most once and never over a newer state.
   * Idempotent by construction: a second call at the same instant finds
   * nothing due and writes nothing.
   *
   * Each transition commits in its own platform-owner transaction with
   * its audit entry, and the public-website serving cache for that
   * organization is invalidated AFTER the commit (the same after-commit
   * rule `PlatformPaymentService.approvePayment` follows, and for the
   * mirror-image reason: clearing it inside the transaction would let a
   * concurrent public read re-cache the pre-commit "still served" answer
   * for a full TTL after the site should have gone dark).
   */
  async expireDuePaidPeriods(
    now: Date = this.clock.now(),
  ): Promise<PaidPeriodSweepResult> {
    const result = { graceStarted: 0, cancelled: 0, expired: 0 };

    const platformOwner = await this.usersRepository.findFirstPlatformOwnerId();
    if (!platformOwner) {
      this.logger.warn(
        'No platform owner account exists yet — skipping paid-period expiry sweep.',
      );
      return result;
    }
    const actorUserId = platformOwner.id;

    const transition = async (subscription: TenantSubscription): Promise<void> => {
      const effective = resolveEffectiveSubscriptionStatus(subscription, now);
      if (effective.effectiveStatus === subscription.status) return;

      const context = {
        previousStatus: subscription.status,
        newStatus: effective.effectiveStatus,
        reason: effective.reason,
        at: now.toISOString(),
        currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
        graceEndsAt: effective.graceEndsAt?.toISOString() ?? null,
      };

      const applied = await this.tenancyContextService.runInUserContext(
        actorUserId,
        async (tx) => {
          let written = false;
          let action: string;
          switch (effective.effectiveStatus) {
            case 'grace_period':
              written = await this.tenantSubscriptionsRepository.markGraceStarted(
                tx,
                subscription.organizationId,
                effective.graceEndsAt!,
              );
              action = SUBSCRIPTION_EXPIRY_AUDIT_ACTIONS.graceStarted;
              break;
            case 'cancelled':
              written = await this.tenantSubscriptionsRepository.markCancelledAtPeriodEnd(
                tx,
                subscription.organizationId,
              );
              action = SUBSCRIPTION_EXPIRY_AUDIT_ACTIONS.cancelledAtPeriodEnd;
              break;
            case 'expired':
              written = await this.tenantSubscriptionsRepository.markExpired(
                tx,
                subscription.organizationId,
                effective.graceEndsAt!,
              );
              action = SUBSCRIPTION_EXPIRY_AUDIT_ACTIONS.expired;
              break;
            default:
              return false;
          }
          // The guarded write matched nothing: another tick or a renewal
          // got there first. No audit entry for a transition that did
          // not happen.
          if (!written) return false;

          await this.auditLogWriterService.write(tx, {
            actorUserId,
            organizationId: subscription.organizationId,
            action,
            targetType: 'tenant_subscription',
            targetId: subscription.organizationId,
            context,
          });
          return true;
        },
      );
      if (!applied) return;

      switch (effective.effectiveStatus) {
        case 'grace_period':
          result.graceStarted++;
          break;
        case 'cancelled':
          result.cancelled++;
          break;
        case 'expired':
          result.expired++;
          break;
      }

      // Serving eligibility may have changed (`cancelled`/`expired` stop
      // the public site; `grace_period` keeps it). Invalidated for every
      // transition rather than only the denying ones, so the cache never
      // holds an answer computed from a status that no longer exists.
      await this.publicWebsiteCacheService.invalidateServingEligibility(
        subscription.organizationId,
      );
    };

    const scan = async (
      findPage: (cursor: string | undefined) => Promise<TenantSubscription[]>,
    ): Promise<void> => {
      let cursor: string | undefined;
      for (;;) {
        const page = await findPage(cursor);
        for (const subscription of page) await transition(subscription);
        if (page.length < SUBSCRIPTION_SWEEP_QUERY_PAGE_SIZE) return;
        cursor = page[page.length - 1].organizationId;
      }
    };

    await scan((cursor) =>
      this.tenancyContextService.runInUserContext(actorUserId, (tx) =>
        this.tenantSubscriptionsRepository.findManyDueForPeriodEnd(
          tx,
          now,
          cursor,
          SUBSCRIPTION_SWEEP_QUERY_PAGE_SIZE,
        ),
      ),
    );
    await scan((cursor) =>
      this.tenancyContextService.runInUserContext(actorUserId, (tx) =>
        this.tenantSubscriptionsRepository.findManyDueForGraceExpiry(
          tx,
          now,
          cursor,
          SUBSCRIPTION_SWEEP_QUERY_PAGE_SIZE,
        ),
      ),
    );

    if (result.graceStarted + result.cancelled + result.expired > 0) {
      this.logger.log(result, 'Transitioned due paid subscription periods.');
    }

    return result;
  }
}
