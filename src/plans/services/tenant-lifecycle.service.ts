/**
 * TenantLifecycleService — P64 Communications C5, the sweep-driven half
 * of `docs/communications/COMMUNICATIONS_AND_LIFECYCLE_PLAN.md` §26 (trial
 * T1–T6) and §27 (subscription S1–S10).
 *
 * NOTHING IS SCHEDULED, EVER. This service is called once per
 * `subscription-sweep` tick (every 15 minutes, the same tick that makes
 * the expiry transitions durable), asks `evaluateLifecycleSteps` which
 * steps are due for each candidate organisation AT THIS INSTANT, and emits
 * them. There is no table of future emails, so a customer who pays two
 * minutes after their trial lapsed has nothing to cancel: the next tick
 * simply no longer returns T4, because the row is `active` now. That is
 * §26's own rule ("Any activation ends the sequence instantly … no
 * scheduled emails exist to cancel") expressed as code rather than as a
 * revocation mechanism that could be forgotten.
 *
 * WHAT KEEPS A REPEATED SWEEP SILENT is the dedupe key, not this service.
 * Every emitted step carries its ANCHOR — the immutable instant it is
 * timed from — in `values.anchorAt`, and the catalogue builds
 * `lifecycle_<step>:<organizationId>:<anchor>` from it. Ninety-six ticks a
 * day re-derive the identical string and every one after the first is
 * rejected by the `(recipient_user_id, dedupe_key)` unique index, inside a
 * SAVEPOINT so the rejection costs nothing. See the catalogue's
 * `lifecycleKey`.
 *
 * IT DOES NOT RE-IMPLEMENT EXPIRY. Which state an organisation is in is
 * `resolveEffectiveSubscriptionStatus`'s answer and nobody else's — the
 * same pure function `SubscriptionAccessService` gates requests with and
 * `SubscriptionExpiryService` persists transitions from. This service only
 * asks it and speaks; it never writes a subscription row.
 *
 * FLAG-GATED. `FLAG_LIFECYCLE_SEQUENCES_MODE` is `off` unless someone sets
 * it, because an unset variable must never be the reason production starts
 * emailing customers (the same rule `FLAG_AUTH_EMAIL_OTP_MODE_*` states).
 * `dry_run` evaluates everything and logs the steps it WOULD have emitted,
 * which is how the first production cycle is meant to be observed.
 *
 * CONTEXT. Everything runs under a real platform-owner user context —
 * `SubscriptionExpiryService`'s established precedent, never
 * `runWithoutContext` — so every read and write stays policy-bound
 * (`organizations_platform_select`, `tenant_lifecycle_state_platform_all`,
 * and the `*_system_insert` policies `CommunicationService.emit` relies on).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { CommunicationService } from '../../communications/services/communication.service';
import type { CommunicationEventKey } from '../../communications/catalog/communication-catalog';
import type {
  CommunicationsConfig,
  LifecycleSequencesMode,
} from '../../config/configuration';
import {
  TenantLifecycleStateRepository,
  type LifecycleCandidate,
} from '../repositories/tenant-lifecycle-state.repository';
import {
  evaluateLifecycleSteps,
  resolveLifecyclePhase,
  type DueLifecycleStep,
  type LifecycleEvaluationInput,
  type LifecycleStepId,
} from '../utils/lifecycle-steps.util';
import { resolveGraceEndsAt } from '../utils/subscription-effective-status.util';
import { PLANS_CLOCK, type Clock } from '../utils/clock';
import { SUBSCRIPTION_SWEEP_QUERY_PAGE_SIZE } from '../queue/subscription-sweep.types';

/**
 * The hard ceiling on organisations one tick will evaluate.
 *
 * The candidate query is already bounded by the sequence windows
 * themselves (see `findCandidates`), so reaching this at all would mean an
 * implausible number of tenants inside a lifecycle window simultaneously.
 * It exists for the same reason `SUBSCRIPTION_SWEEP_MAX_RECOMPUTE_PER_TICK`
 * does: a sweep whose per-tick cost is unbounded is a scalability defect
 * waiting for the platform to grow into it. Hitting it logs a warning and
 * defers the remainder to the next tick — and because steps are evaluated
 * fresh each time within a two-day lateness horizon, a deferred
 * organisation loses nothing.
 */
export const LIFECYCLE_MAX_ORGS_PER_TICK = 5000;

/** Anonymised accounts keep a row but must never be mailed — mirrors the dispatcher's own rule. */
const ANONYMISED_EMAIL_DOMAIN = '@account.invalid';

export interface LifecycleSweepResult {
  readonly mode: LifecycleSequencesMode;
  readonly organizationsEvaluated: number;
  readonly stepsDue: number;
  readonly stepsEmitted: number;
  readonly stepsDeduped: number;
}

/** One catalogue key per clock-driven step. The event-driven four (T1, S1, S2, S8) are emitted by the actions that cause them. */
const STEP_EVENT_KEY: Record<LifecycleStepId, CommunicationEventKey> = {
  trial_ending_soon: 'lifecycle.trial.ending_soon',
  trial_expired: 'lifecycle.trial.expired',
  trial_followup_3d: 'lifecycle.trial.followup_3d',
  trial_followup_14d: 'lifecycle.trial.followup_14d',
  trial_reactivation_45d: 'lifecycle.trial.reactivation_45d',
  subscription_renewal_due: 'lifecycle.subscription.renewal_due',
  subscription_renewal_tomorrow: 'lifecycle.subscription.renewal_tomorrow',
  subscription_grace_started: 'lifecycle.subscription.grace_started',
  subscription_grace_ending: 'lifecycle.subscription.grace_ending',
  subscription_expired: 'lifecycle.subscription.expired',
  subscription_cancelled: 'lifecycle.subscription.cancelled',
  subscription_followup_7d: 'lifecycle.subscription.followup_7d',
  subscription_followup_30d: 'lifecycle.subscription.followup_30d',
};

/**
 * `2026-10-01 09:00 UTC` — unambiguous in both locales and in every mail
 * client, and it never claims a timezone the recipient did not give us.
 * `academies.timezone` exists but belongs to an academy, not to the
 * organisation owner reading a billing email.
 */
export function formatLifecycleInstant(at: Date): string {
  const iso = at.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

@Injectable()
export class TenantLifecycleService {
  private readonly logger = new Logger(TenantLifecycleService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly usersRepository: UsersRepository,
    private readonly repository: TenantLifecycleStateRepository,
    private readonly communicationService: CommunicationService,
    private readonly configService: ConfigService,
    @Inject(PLANS_CLOCK) private readonly clock: Clock,
  ) {}

  get mode(): LifecycleSequencesMode {
    return this.configService.getOrThrow<CommunicationsConfig>('communications')
      .lifecycleSequencesMode;
  }

  /** One sweep tick. Directly callable by the sweep and by tests, exactly like `expireDuePaidPeriods`. */
  async run(now: Date = this.clock.now()): Promise<LifecycleSweepResult> {
    const mode = this.mode;
    const result = {
      mode,
      organizationsEvaluated: 0,
      stepsDue: 0,
      stepsEmitted: 0,
      stepsDeduped: 0,
    };
    if (mode === 'off') return result;

    const platformOwner = await this.usersRepository.findFirstPlatformOwnerId();
    if (!platformOwner) {
      this.logger.warn(
        'No platform owner account exists yet — skipping lifecycle sequence evaluation.',
      );
      return result;
    }
    const actorUserId = platformOwner.id;

    let cursor: string | undefined;
    for (;;) {
      const remaining = LIFECYCLE_MAX_ORGS_PER_TICK - result.organizationsEvaluated;
      if (remaining <= 0) {
        this.logger.warn(
          { ceiling: LIFECYCLE_MAX_ORGS_PER_TICK },
          'Lifecycle sequence evaluation hit its per-tick ceiling — the remainder is evaluated on the next tick, not skipped.',
        );
        break;
      }
      const take = Math.min(remaining, SUBSCRIPTION_SWEEP_QUERY_PAGE_SIZE);
      const page = await this.tenancyContextService.runInUserContext(actorUserId, (tx) =>
        this.repository.findCandidates(tx, now, cursor, take),
      );
      if (page.length === 0) break;

      for (const candidate of page) {
        result.organizationsEvaluated++;
        const counts = await this.evaluateOne(candidate, now, actorUserId, mode);
        result.stepsDue += counts.due;
        result.stepsEmitted += counts.emitted;
        result.stepsDeduped += counts.deduped;
      }

      cursor = page[page.length - 1].organizationId;
      if (page.length < take) break;
    }

    if (result.stepsDue > 0 || result.stepsEmitted > 0) {
      this.logger.log(result, 'Lifecycle sequence tick complete.');
    }
    return result;
  }

  private async evaluateOne(
    candidate: LifecycleCandidate,
    now: Date,
    actorUserId: string,
    mode: LifecycleSequencesMode,
  ): Promise<{ due: number; emitted: number; deduped: number }> {
    const counts = { due: 0, emitted: 0, deduped: 0 };
    const organizationId = candidate.organizationId;

    /*
      RECIPIENT FIRST, AND SERVER-AUTHORITATIVE (§34). The organisation's
      owner is the only address this sequence ever writes to, and an
      account that is deleted, suspended-into-deletion or already
      anonymised is not a person we may mail — the same three checks the
      dispatcher's own `loadRecipient` makes, applied one layer earlier so
      a dead tenant does not even produce an outbox row to be suppressed.
    */
    const owner = candidate.organization.owner;
    if (
      !owner ||
      owner.deletedAt !== null ||
      owner.status === 'deleted' ||
      owner.email.toLowerCase().endsWith(ANONYMISED_EMAIL_DOMAIN)
    ) {
      return counts;
    }

    const input = toEvaluationInput(candidate);
    const allDue = evaluateLifecycleSteps(input, now);

    // §26 T5/T6 — the content question is I/O, so it is asked only when a
    // step that needs it is otherwise due, and at most once per tenant.
    let steps: readonly DueLifecycleStep[] = allDue;
    if (allDue.some((step) => step.requiresContent)) {
      const hasContent = await this.tenancyContextService.runInUserContext(
        actorUserId,
        (tx) => this.repository.hasContent(tx, organizationId),
      );
      if (!hasContent) steps = allDue.filter((step) => !step.requiresContent);
    }
    counts.due = steps.length;

    let lastEmitted: DueLifecycleStep | null = null;
    for (const step of steps) {
      if (mode === 'dry_run') {
        this.logger.log(
          {
            organizationId,
            step: step.step,
            dueAt: step.dueAt.toISOString(),
            anchorAt: step.anchorAt.toISOString(),
          },
          'Lifecycle step would be emitted (dry run).',
        );
        continue;
      }

      /*
        One transaction per step, not one per organisation: a step whose
        emit fails (an unexpected constraint, a template value the
        catalogue rejects) must not take the organisation's other due
        steps down with it, and a deduped step must not leave the
        transaction that also carries a genuinely new one in an aborted
        state. `emit` guards the duplicate INSERT with a SAVEPOINT for
        exactly that reason; a transaction per step makes the blast radius
        one step regardless.
      */
      const emitted = await this.tenancyContextService.runInUserContext(
        actorUserId,
        (tx) =>
          this.communicationService.emit(tx, {
            key: STEP_EVENT_KEY[step.step],
            recipientUserId: owner.id,
            organizationId,
            entity: { type: 'tenant_subscription', id: organizationId },
            values: this.buildValues(candidate, step),
          }),
      );
      if (emitted.created) {
        counts.emitted++;
        lastEmitted = step;
      } else {
        // The expected outcome on 95 of every 96 ticks a step is due.
        counts.deduped++;
      }
      await this.communicationService.enqueueAfterCommit(emitted.outboxId);
    }

    const phase = resolveLifecyclePhase(input, now);
    await this.tenancyContextService.runInUserContext(actorUserId, (tx) =>
      this.repository.upsertState(tx, {
        organizationId,
        phase: phase.phase,
        origin: phase.origin,
        anchorAt: phase.anchorAt,
        ...(lastEmitted
          ? { lastStep: lastEmitted.step, lastStepAt: lastEmitted.dueAt }
          : {}),
      }),
    );

    return counts;
  }

  /**
   * The interpolation values for one step.
   *
   * `anchorAt` is on EVERY step and is the only value the dedupe key
   * reads — the dated strings beside it are copy, and changing how a date
   * is formatted must never change an idempotency key. That separation is
   * why the ISO instant is passed as well as the display form.
   */
  private buildValues(
    candidate: LifecycleCandidate,
    step: DueLifecycleStep,
  ): Record<string, unknown> {
    const anchorAt = step.anchorAt.toISOString();
    const planName = candidate.plan?.name ?? '';
    const graceEndsAt = resolveGraceEndsAt(candidate);
    const base = { anchorAt, planName };

    switch (step.step) {
      case 'trial_ending_soon':
        return {
          ...base,
          trialEndsAtDate: formatLifecycleInstant(step.anchorAt),
        };
      case 'trial_expired':
      case 'trial_followup_3d':
      case 'trial_followup_14d':
      case 'trial_reactivation_45d':
        return { ...base, endedAtDate: formatLifecycleInstant(step.anchorAt) };
      case 'subscription_renewal_due':
      case 'subscription_renewal_tomorrow':
        return { ...base, periodEndDate: formatLifecycleInstant(step.anchorAt) };
      case 'subscription_grace_started':
        return {
          ...base,
          periodEndDate: formatLifecycleInstant(step.anchorAt),
          graceEndsAtDate: graceEndsAt ? formatLifecycleInstant(graceEndsAt) : '',
        };
      case 'subscription_grace_ending':
      case 'subscription_expired':
        return { ...base, graceEndsAtDate: formatLifecycleInstant(step.anchorAt) };
      case 'subscription_cancelled':
        return { ...base, effectiveAtDate: formatLifecycleInstant(step.anchorAt) };
      case 'subscription_followup_7d':
      case 'subscription_followup_30d':
        return { ...base, expiredAtDate: formatLifecycleInstant(step.anchorAt) };
    }
  }
}

/**
 * The candidate row as the pure evaluator wants it: the subscription's
 * dated columns, plus which KIND of cancellation (if any) this
 * organisation recorded.
 *
 * The kind is load-bearing, not decoration. `markTrialCancelled` and
 * `markCancelledAtPeriodEnd` both write the same `cancelled` status, and
 * §26 and §27 give those two customers different sequences: a cancelled
 * trial gets T3 and nothing else; a cancelled paid subscription gets S9.
 * `subscription_cancellations.kind` is the only fact that separates them,
 * and it is unique per (organisation, kind) so at most one of each exists.
 */
function toEvaluationInput(candidate: LifecycleCandidate): LifecycleEvaluationInput {
  const cancellations = candidate.organization.cancellations;
  return {
    subscription: {
      status: candidate.status,
      trialEndsAt: candidate.trialEndsAt,
      currentPeriodEnd: candidate.currentPeriodEnd,
      graceEndsAt: candidate.graceEndsAt,
      cancelAtPeriodEnd: candidate.cancelAtPeriodEnd,
    },
    trialCancelledAt:
      cancellations.find((row) => row.kind === 'trial')?.effectiveAt ?? null,
    paidCancelledAt:
      cancellations.find((row) => row.kind === 'paid')?.effectiveAt ?? null,
  };
}
