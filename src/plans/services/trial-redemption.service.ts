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
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { limitsToGrant } from '../utils/granted-limits.util';
import { Prisma } from '@prisma/client';
import type { Plan } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { TrialPolicyRepository } from '../repositories/trial-policy.repository';
import { PlansRepository } from '../repositories/plans.repository';
import { TenantSubscriptionsRepository } from '../repositories/tenant-subscriptions.repository';
import { TrialEligibilityService } from './trial-eligibility.service';
import type { TrialClaimContext } from './trial-eligibility.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { CommunicationService } from '../../communications/services/communication.service';
import type { EmitResult } from '../../communications/services/communication.service';
import { formatLifecycleInstant } from './tenant-lifecycle.service';

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

/** A plan a signup may trial, with the duration it would run for. */
export interface SignupTrialPlan {
  readonly plan: Plan;
  readonly durationDays: number;
}

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
    // P64 C5 — §26 T1 and §27 S8 are emitted by the ACTIONS that cause
    // them, inside those actions' own transactions, not by the sweep: a
    // trial that rolls back must leave no "your trial has started", and a
    // cancellation the customer just confirmed must not wait 15 minutes
    // for its receipt. Everything a CLOCK decides lives in
    // `TenantLifecycleService` instead.
    private readonly communicationService: CommunicationService,
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

    /*
      PER-PLAN ELIGIBILITY, READ FROM THE CATALOG (Phase 11).

      Enterprise is not a self-service trial tier. That rule is a column on
      the plan, not a comparison against a plan key here — so making a
      future plan trialable is an UPDATE, not a deploy, and there is
      exactly one place to change it. Enforced server-side because the
      frontend's copy of this flag is display only: without this check a
      caller could POST the Enterprise plan id directly and trial unlimited
      everything for free.
    */
    if (!plan.trialEligible) {
      throw new ForbiddenException({
        messageKey: 'errors.entitlement.planNotTrialEligible',
        code: 'PLAN_NOT_TRIAL_ELIGIBLE',
      });
    }

    // Per-plan duration when the catalog specifies one, the platform
    // default otherwise. Neither "3" nor any plan name appears here.
    const durationDays = plan.trialDurationDays ?? trialPolicy.durationDays;
    const trialEndsAt = new Date(Date.now() + durationDays * MS_PER_DAY);

    let emitted: EmitResult = { created: false, outboxId: null };
    const result = await this.tenancyContextService
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
          // P61 — a trial grants a real entitlement, so it records what it
          // granted. Without this, editing the catalog mid-trial would
          // shrink a trial the customer is actively evaluating, which is
          // the worst possible moment to move the goalposts.
          limitsToGrant(plan) as unknown as Prisma.InputJsonValue,
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

        emitted = await this.recordTrialStarted(tx, {
          organizationId,
          actorUserId,
          ownerUserId: owner.id,
          plan,
          trialEndsAt,
          durationDays,
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

    // After commit, and only when a trial was really granted — a rolled
    // back transaction left no outbox row to dispatch.
    if (result.started) {
      await this.communicationService.enqueueAfterCommit(emitted.outboxId);
    }
    return result;
  }

  /**
   * The audit entry and the §26 T1 "your trial has started" outbox entry,
   * written inside the caller's transaction so a trial that rolls back
   * leaves neither behind. Shared by `startTrial` and the signup path.
   *
   * The dedupe anchor is `trialEndsAt`, which no later transition ever
   * rewrites (`markTrialExpired` and `markTrialCancelled` both preserve it,
   * deliberately), so a retried request can never produce a second "your
   * trial has started".
   */
  private async recordTrialStarted(
    tx: Prisma.TransactionClient,
    input: {
      readonly organizationId: string;
      readonly actorUserId: string;
      readonly ownerUserId: string;
      readonly plan: { readonly key: string; readonly name: string };
      readonly trialEndsAt: Date;
      readonly durationDays: number;
    },
  ): Promise<EmitResult> {
    await this.auditLogWriterService.write(tx, {
      actorUserId: input.actorUserId,
      organizationId: input.organizationId,
      action: 'subscription.trial.redeemed',
      targetType: 'tenant_subscription',
      targetId: input.organizationId,
      context: {
        planKey: input.plan.key,
        trialEndsAt: input.trialEndsAt.toISOString(),
        // The duration actually applied, which may be the plan's own
        // override rather than the platform default.
        durationDays: input.durationDays,
      },
    });

    return this.communicationService.emit(tx, {
      key: 'lifecycle.trial.started',
      recipientUserId: input.ownerUserId,
      organizationId: input.organizationId,
      entity: { type: 'tenant_subscription', id: input.organizationId },
      values: {
        anchorAt: input.trialEndsAt.toISOString(),
        trialEndsAtDate: formatLifecycleInstant(input.trialEndsAt),
        planName: input.plan.name,
      },
    });
  }

  /**
   * New Customer Onboarding — validates the plan a signup asked to trial,
   * BEFORE anything is written (docs/NEW_CUSTOMER_ONBOARDING.md §3.2).
   *
   * The same rules `startTrial` applies, plus the catalog's customer-facing
   * floor (`displayOrder > 0`, the public plans endpoint's own filter): a
   * signup may only name a plan the signup page could have shown. Errors are
   * 400s with signup-specific keys because the form, not the Plans page,
   * has to explain them.
   */
  async resolveSignupTrialPlan(planId: string): Promise<SignupTrialPlan> {
    const trialPolicy = await this.trialPolicyRepository.findSingleton();
    if (!trialPolicy.enabled) {
      throw new BadRequestException({
        messageKey: 'errors.auth.signupTrialsUnavailable',
      });
    }
    const plan = await this.plansRepository.findById(planId);
    if (
      !plan ||
      plan.status !== 'active' ||
      plan.displayOrder <= 0 ||
      !plan.trialEligible
    ) {
      throw new BadRequestException({ messageKey: 'errors.auth.signupPlanUnavailable' });
    }
    return { plan, durationDays: plan.trialDurationDays ?? trialPolicy.durationDays };
  }

  /**
   * New Customer Onboarding — the signup's Free Trial, inside the SIGNUP's
   * transaction (the caller has set both RLS contexts on `tx`).
   *
   * BOTH trial-abuse guards are kept, in the opposite order to `startTrial`:
   *
   *   1. `claimTrial` FIRST — the once-per-mailbox claim. It is an
   *      `INSERT ... ON CONFLICT DO NOTHING`, which never raises, so a
   *      mailbox that already had a trial (a plus-address of it, or a
   *      deleted-and-re-registered account) leaves this transaction healthy
   *      and the signup simply proceeds WITHOUT a trial (`no_plan`), which
   *      is the state the paid checkout path starts from.
   *   2. `startTrial` — the conditional per-organization update. The
   *      organization was created in this same transaction as `no_plan`, so
   *      it cannot lose; if it ever did, throwing rolls the whole signup
   *      back rather than leaving a consumed claim without a trial.
   *
   * `startTrial` above cannot use this order: it has no transaction to keep
   * alive and rolls back by throwing, which here would undo the account.
   */
  async grantSignupTrialInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      readonly organizationId: string;
      readonly owner: { readonly id: string; readonly email: string };
      readonly resolved: SignupTrialPlan;
      readonly context?: TrialClaimContext;
    },
  ): Promise<{ readonly started: boolean; readonly outboxId: string | null }> {
    const { plan, durationDays } = input.resolved;
    const trialEndsAt = new Date(Date.now() + durationDays * MS_PER_DAY);

    const claim = await this.trialEligibilityService.claimTrial(tx, {
      email: input.owner.email,
      organizationId: input.organizationId,
      userId: input.owner.id,
      trialEndsAt,
      context: input.context,
    });
    if (!claim.granted) return { started: false, outboxId: null };

    const started = await this.tenantSubscriptionsRepository.startTrial(
      tx,
      input.organizationId,
      plan.id,
      trialEndsAt,
      limitsToGrant(plan) as unknown as Prisma.InputJsonValue,
    );
    if (!started) {
      throw new Error('Signup trial could not start on a brand-new organization.');
    }

    const emitted = await this.recordTrialStarted(tx, {
      organizationId: input.organizationId,
      actorUserId: input.owner.id,
      ownerUserId: input.owner.id,
      plan,
      trialEndsAt,
      durationDays,
    });
    return { started: true, outboxId: emitted.outboxId };
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
   *
   * W8 D1 — IDEMPOTENT PER PAID PERIOD, not per organization forever. The
   * cancellation row is unique per (organization, effective_at) for paid
   * cancellations (partial index, migration 20261104000640), and
   * `effective_at` is the current period end. A repeat inside the same
   * period reports `alreadyCancelled`; after a renewal the period end has
   * moved, so cancelling again records a new row and sets
   * `cancelAtPeriodEnd` again. Previously the second cancel was a silent
   * no-op and the subscription kept renewing.
   */
  async cancelSubscription(
    organizationId: string,
    actorUserId: string,
    input: CancelInput,
  ): Promise<CancelResult> {
    let emitted: EmitResult = { created: false, outboxId: null };
    const result = await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      actorUserId,
      async (tx) => {
        const subscription = await tx.tenantSubscription.findUnique({
          where: { organizationId },
          select: { currentPeriodEnd: true, status: true, cancelAtPeriodEnd: true },
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
          // Same period, already recorded. Self-heal the flag if something
          // cleared it without moving the period end, so "already
          // cancelled" is never reported for a subscription that renews.
          if (subscription && !subscription.cancelAtPeriodEnd) {
            await this.tenantSubscriptionsRepository.markPaidCancelAtPeriodEnd(
              tx,
              organizationId,
            );
          }
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

        /*
          §27 S8 — "Cancellation scheduled … confirmation with effective
          date". Emitted only on the call that actually RECORDED the
          cancellation (a repeat returns above, at `alreadyCancelled`), so
          an idempotent re-request never sends a second confirmation. The
          anchor is the cancellation's own `effectiveAt` — the customer's
          paid-through date, which never moves.

          The recipient is the ORGANISATION OWNER, not the actor: a
          manager may hold the permission to cancel, but the person who
          must be told is the account's owner (§34, "recipient is
          server-authoritative").
        */
        const organization = await tx.organization.findUnique({
          where: { id: organizationId },
          select: { ownerUserId: true },
        });
        if (organization) {
          emitted = await this.communicationService.emit(tx, {
            key: 'lifecycle.subscription.cancel_scheduled',
            recipientUserId: organization.ownerUserId,
            organizationId,
            entity: { type: 'tenant_subscription', id: organizationId },
            values: {
              anchorAt: effectiveAt.toISOString(),
              effectiveAtDate: formatLifecycleInstant(effectiveAt),
            },
          });
        }

        return { cancelled: true, alreadyCancelled: false, effectiveAt };
      },
    );

    if (result.cancelled) {
      await this.communicationService.enqueueAfterCommit(emitted.outboxId);
    }
    return result;
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
