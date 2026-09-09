/**
 * TrialRedemptionService — the ONLY place a Free Trial is ever granted,
 * and the place trials and paid subscriptions are cancelled.
 *
 * THE PRODUCT FLOW THIS IMPLEMENTS (Phase 10.2):
 *
 *   create account -> create Organization -> NO trial
 *   -> open Plans -> choose a plan -> "Start Free Trial"
 *   -> explicit confirmation -> eligibility checked -> trial or refusal
 *
 * Every step before the explicit confirmation is trial-free. Creating an
 * account grants nothing, creating an Organization grants nothing
 * (`OrganizationSubscriptionBootstrapService` now writes an inactive
 * subscription row), viewing Plans grants nothing, and selecting a plan
 * grants nothing. `startTrial` below is the single entry point, and it is
 * reachable only from an authenticated, explicitly-confirmed request.
 *
 * WHY REDEMPTION AND CANCELLATION LIVE TOGETHER: because the one rule
 * that must never be violated spans both. Cancelling a trial must not
 * return the trial. Keeping both operations in one file makes it
 * impossible to add a cancellation path that quietly deletes a redemption
 * without seeing this comment.
 */
import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { TrialPolicyRepository } from '../repositories/trial-policy.repository';
import { PlansRepository } from '../repositories/plans.repository';
import { TenantSubscriptionsRepository } from '../repositories/tenant-subscriptions.repository';
import { TrialEligibilityService } from './trial-eligibility.service';
import type { TrialClaimContext } from './trial-eligibility.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Closed vocabulary. Validated server-side so the admin dashboard can
 * aggregate reasons; anything free-form belongs in `feedback`.
 */
export const CANCELLATION_REASONS = [
  'too_expensive',
  'missing_features',
  'not_using_it',
  'too_difficult',
  'switching_provider',
  'temporary_pause',
  'other',
] as const;

export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

export interface StartTrialResult {
  readonly started: boolean;
  readonly reason?: 'already_redeemed' | 'already_has_subscription';
  readonly trialEndsAt?: Date;
}

export interface CancelInput {
  readonly reason: CancellationReason;
  /** Optional by contract and by database column. Never required to cancel. */
  readonly feedback?: string;
}

export interface CancelResult {
  readonly cancelled: boolean;
  /** True when a prior cancellation already existed — the request is a no-op, not an error. */
  readonly alreadyCancelled: boolean;
  readonly effectiveAt: Date;
}

@Injectable()
export class TrialRedemptionService {
  private readonly logger = new Logger(TrialRedemptionService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly trialPolicyRepository: TrialPolicyRepository,
    private readonly plansRepository: PlansRepository,
    private readonly tenantSubscriptionsRepository: TenantSubscriptionsRepository,
    private readonly trialEligibilityService: TrialEligibilityService,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

  /**
   * Redeems the caller's one Free Trial for this Organization.
   *
   * CONCURRENCY. Two independent guards, both in the database, both
   * inside one transaction:
   *
   *   1. `claimTrial` — INSERT ... ON CONFLICT DO NOTHING against a
   *      UNIQUE index on the subject hash. Exactly one caller can ever
   *      win this for a given mailbox, across all Organizations and all
   *      time.
   *   2. `startTrial` — a conditional UPDATE that only matches a
   *      subscription which has never had a trial.
   *
   * Either alone would be sufficient for the common case; together they
   * mean neither a repeated request, a double-clicked button, a retried
   * webhook, nor two simultaneous requests can produce two trials.
   *
   * The whole thing runs in one transaction, so a failure after the claim
   * rolls the redemption back rather than burning the user's only trial.
   */
  async startTrial(
    organizationId: string,
    actorUserId: string,
    planId: string | undefined,
    context?: TrialClaimContext,
  ): Promise<StartTrialResult> {
    const trialPolicy = await this.trialPolicyRepository.findSingleton();
    if (!trialPolicy.enabled) {
      throw new ForbiddenException({ messageKey: 'errors.entitlement.trialsDisabled' });
    }

    // The plan the user actually chose on the Plans page, falling back to
    // the default trial tier. Validated against the real catalog, and the
    // `status` check is not incidental: without it a caller could pass
    // the id of an intentionally archived plan and trial something the
    // platform no longer sells.
    const chosen = planId
      ? await this.plansRepository.findById(planId)
      : await this.plansRepository.findDefaultTrialPlan();

    const plan = chosen && chosen.status === 'active' ? chosen : null;

    if (!plan) {
      throw new ForbiddenException({ messageKey: 'errors.entitlement.noPlanAvailable' });
    }

    const trialEndsAt = new Date(Date.now() + trialPolicy.durationDays * MS_PER_DAY);

    return this.tenancyContextService
      .runInTenantAndUserContext(organizationId, actorUserId, async (tx) => {
        const owner = await tx.user.findUniqueOrThrow({
          where: { id: actorUserId },
          select: { id: true, email: true },
        });

        // Guard 2 first: cheap, and it distinguishes "this Organization
        // already had a trial" from "this person already had one", which
        // are different messages to the user.
        const started = await this.tenantSubscriptionsRepository.startTrial(
          tx,
          organizationId,
          plan.id,
          trialEndsAt,
        );

        if (!started) {
          return { started: false, reason: 'already_has_subscription' as const };
        }

        // Guard 1: the durable, cross-Organization rule.
        const claim = await this.trialEligibilityService.claimTrial(tx, {
          email: owner.email,
          organizationId,
          userId: owner.id,
          trialEndsAt,
          context,
        });

        if (!claim.granted) {
          // Undo the optimistic status change by rolling the whole
          // transaction back. Throwing here is the cleanest way to do
          // that atomically — it is caught immediately below and turned
          // back into an ordinary business result, never surfaced as a
          // 500.
          throw new TrialAlreadyRedeemedError();
        }

        await this.auditLogWriterService.write(tx, {
          actorUserId,
          organizationId,
          action: 'subscription.trial.redeemed',
          targetType: 'tenant_subscription',
          targetId: organizationId,
          context: {
            planKey: plan.key,
            trialEndsAt: trialEndsAt.toISOString(),
            durationDays: trialPolicy.durationDays,
          },
        });

        return { started: true, trialEndsAt };
      })
      .catch((error: unknown) => {
        if (error instanceof TrialAlreadyRedeemedError) {
          this.logger.log(
            { organizationId },
            'Free Trial refused — this subject has already redeemed one.',
          );
          return { started: false, reason: 'already_redeemed' as const };
        }
        throw error;
      });
  }

  /**
   * Cancels an active Free Trial. Access ends immediately.
   *
   * DOES NOT RESTORE ELIGIBILITY. Nothing here touches
   * `trial_redemptions`, and the application role has no DELETE privilege
   * on that table regardless — so a cancelled trial stays redeemed
   * permanently and cannot be re-taken from another Organization, device,
   * browser, IP or account.
   *
   * IDEMPOTENT. The cancellation record has a UNIQUE (organization, kind)
   * constraint and is written with ON CONFLICT DO NOTHING, so a repeated
   * or concurrent request reports `alreadyCancelled` instead of raising or
   * writing a second row.
   */
  async cancelTrial(
    organizationId: string,
    actorUserId: string,
    input: CancelInput,
  ): Promise<CancelResult> {
    // A trial ends the moment it is cancelled — there is no paid period
    // to honour.
    const effectiveAt = new Date();

    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      actorUserId,
      async (tx) => {
        const recorded = await this.recordCancellation(tx, {
          organizationId,
          kind: 'trial',
          actorUserId,
          input,
          effectiveAt,
        });

        if (!recorded) {
          return { cancelled: false, alreadyCancelled: true, effectiveAt };
        }

        await this.tenantSubscriptionsRepository.markTrialCancelled(tx, organizationId);

        await this.auditLogWriterService.write(tx, {
          actorUserId,
          organizationId,
          action: 'subscription.trial.cancelled',
          targetType: 'tenant_subscription',
          targetId: organizationId,
          context: {
            reason: input.reason,
            hasFeedback: Boolean(input.feedback),
            effectiveAt: effectiveAt.toISOString(),
          },
        });

        return { cancelled: true, alreadyCancelled: false, effectiveAt };
      },
    );
  }

  /**
   * Cancels a paid subscription at the end of the period already paid
   * for.
   *
   * Access is NOT revoked immediately: the customer paid through
   * `currentPeriodEnd` and keeps that time. The subscription is flagged
   * `cancelAtPeriodEnd`, and the existing expiry sweep performs the
   * actual transition — this method deliberately does not invent a second
   * expiry mechanism alongside it.
   */
  async cancelSubscription(
    organizationId: string,
    actorUserId: string,
    input: CancelInput,
  ): Promise<CancelResult> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      actorUserId,
      async (tx) => {
        const subscription = await tx.tenantSubscription.findUnique({
          where: { organizationId },
          select: { currentPeriodEnd: true, status: true },
        });

        // Falls back to "now" only when no paid period is recorded, which
        // is the honest answer for a subscription that never had one.
        const effectiveAt = subscription?.currentPeriodEnd ?? new Date();

        const recorded = await this.recordCancellation(tx, {
          organizationId,
          kind: 'paid',
          actorUserId,
          input,
          effectiveAt,
        });

        if (!recorded) {
          return { cancelled: false, alreadyCancelled: true, effectiveAt };
        }

        await this.tenantSubscriptionsRepository.markPaidCancelAtPeriodEnd(
          tx,
          organizationId,
        );

        await this.auditLogWriterService.write(tx, {
          actorUserId,
          organizationId,
          action: 'subscription.cancelled',
          targetType: 'tenant_subscription',
          targetId: organizationId,
          context: {
            reason: input.reason,
            hasFeedback: Boolean(input.feedback),
            effectiveAt: effectiveAt.toISOString(),
            previousStatus: subscription?.status ?? 'unknown',
          },
        });

        return { cancelled: true, alreadyCancelled: false, effectiveAt };
      },
    );
  }

  /**
   * Writes the cancellation record, returning whether THIS call created
   * it.
   *
   * `createMany({ skipDuplicates })` compiles to ON CONFLICT DO NOTHING.
   * That matters for the same reason it does in
   * `TrialEligibilityService`: a raised unique violation would abort the
   * caller's whole transaction in Postgres, and no application-level
   * catch could rescue it. This never raises, so idempotency costs
   * nothing.
   */
  private async recordCancellation(
    tx: Prisma.TransactionClient,
    args: {
      organizationId: string;
      kind: 'trial' | 'paid';
      actorUserId: string;
      input: CancelInput;
      effectiveAt: Date;
    },
  ): Promise<boolean> {
    const inserted = await tx.subscriptionCancellation.createMany({
      data: [
        {
          organizationId: args.organizationId,
          kind: args.kind,
          reason: args.input.reason,
          // Trimmed to nothing becomes null rather than an empty string,
          // so "no feedback" is one value in the database, not two.
          feedback: args.input.feedback?.trim() || null,
          cancelledByUserId: args.actorUserId,
          effectiveAt: args.effectiveAt,
        },
      ],
      skipDuplicates: true,
    });
    return inserted.count === 1;
  }
}

/** Internal control-flow signal — never leaves this service, never reaches a controller. */
class TrialAlreadyRedeemedError extends Error {
  constructor() {
    super('Trial already redeemed by this subject.');
  }
}
