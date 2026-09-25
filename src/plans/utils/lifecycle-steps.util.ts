/**
 * The tenant lifecycle SEQUENCE EVALUATOR — P64 Communications C5, the
 * pure half of `docs/communications/COMMUNICATIONS_AND_LIFECYCLE_PLAN.md`
 * §26 (trial T1–T6) and §27 (subscription S1–S10).
 *
 * NOTHING IS EVER SCHEDULED. The plan's own rule: "Any activation ends the
 * sequence instantly because the sweep re-evaluates conditions each tick;
 * no scheduled emails exist to cancel." So this file answers ONE question,
 * for ONE organisation, at ONE instant — "which steps are due right now?" —
 * and the sweep asks it again 15 minutes later. There is no queue of
 * future emails, therefore nothing to revoke when a customer pays: the
 * next tick simply stops returning the step.
 *
 * PURE ON PURPOSE, exactly like `resolveEffectiveSubscriptionStatus` (which
 * it calls): no I/O, no injected services, no `new Date()`. `now` is always
 * an argument, so the e2e suite can stand 1 ms either side of a boundary
 * without sleeping, and the unit spec can assert every condition of §26/§27
 * without a database.
 *
 * WHAT MAKES A REPEATED SWEEP SILENT. Not this file — the dedupe key does
 * (the catalogue's own `lifecycleKey`, enforced by the
 * `(recipient_user_id, dedupe_key)` unique index on `communication_outbox`
 * and `notifications`).
 * Every key is built from the entity (the organisation) and the step, plus
 * the step's ANCHOR INSTANT: the immutable timestamp the step's timing is
 * derived from (`trialEndsAt`, `currentPeriodEnd`, `graceEndsAt`, a
 * cancellation's `effectiveAt`). A tick five minutes later re-derives the
 * identical string and the INSERT is rejected; a genuinely new occurrence
 * (a renewal, which moves `currentPeriodEnd`) derives a different one and
 * is allowed. That is the single most important correctness property here,
 * which is why the anchor is carried on every returned step rather than
 * recomputed at the call site.
 *
 * THE LATENESS HORIZON. A step is due in a WINDOW — `[dueAt, dueAt +
 * LIFECYCLE_STEP_MAX_LATENESS_MS]` — never "at any time after `dueAt`".
 * Two reasons, both real:
 *   1. A terminal condition (`trial_expired`, `expired`) holds FOREVER.
 *      Without a horizon, deploying this code would immediately emit T3
 *      and S7 for every organisation that lapsed months ago — a backfill
 *      blast of "your site is now offline" to people who found that out
 *      long ago.
 *   2. A reminder that arrives days late is wrong, not merely late.
 * The short-notice steps (T2, S3, S4, S6) additionally cannot outlive the
 * thing they warn about, because their conditions require the subscription
 * to still BE in the state being warned about — so the horizon only ever
 * bounds the terminal and follow-up steps, and a two-day sweep outage is
 * the only thing it can cost. See `LIFECYCLE_STEP_MAX_LATENESS_MS`.
 */
import {
  resolveEffectiveSubscriptionStatus,
  resolveGraceEndsAt,
  type EffectiveStatusInput,
} from './subscription-effective-status.util';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How late a step may still be emitted after it fell due.
 *
 * Two days, against a sweep that runs every 15 minutes: eight ticks would
 * have to be missed in a row before anything is skipped, and the only
 * thing a longer outage costs is one nudge in a sequence that has five
 * more. Deliberately NOT unbounded — see this file's header, reason (1):
 * an unbounded window makes the first deployment of this code a mass
 * mailing to every organisation that ever lapsed.
 */
export const LIFECYCLE_STEP_MAX_LATENESS_MS = 2 * DAY_MS;

/**
 * The horizon for the three SHORT-NOTICE steps — T2, S4 and S6, the ones
 * whose copy says "tomorrow".
 *
 * Their status conditions already stop them outliving the thing they warn
 * about (T2 needs the trial to still be running, S4 an unexpired period,
 * S6 an open grace window), but that leaves a real gap: after a long
 * outage, "your period ends tomorrow" could still be emitted twenty-three
 * hours after it fell due, i.e. minutes before the period actually ends.
 * That email is not late, it is wrong. Six hours is short enough that the
 * statement is still true when it is read and long enough to survive any
 * outage a 15-minute sweep realistically has.
 */
export const LIFECYCLE_SHORT_NOTICE_LATENESS_MS = 6 * HOUR_MS;

/** The three steps whose subject line says "tomorrow". */
const SHORT_NOTICE_STEPS = new Set<string>([
  'trial_ending_soon',
  'subscription_renewal_tomorrow',
  'subscription_grace_ending',
]);

/** §26 T2 — one reminder, a day ahead. */
export const TRIAL_ENDING_SOON_LEAD_MS = 24 * HOUR_MS;
/** §26 T4/T5/T6 — measured from the instant the trial site went offline. */
export const TRIAL_FOLLOWUP_3D_MS = 3 * DAY_MS;
export const TRIAL_FOLLOWUP_14D_MS = 14 * DAY_MS;
export const TRIAL_REACTIVATION_45D_MS = 45 * DAY_MS;
/** §27 S3/S4 — manual bank transfer plus platform review needs days, not hours. */
export const RENEWAL_REMINDER_LEAD_MS = 7 * DAY_MS;
export const RENEWAL_FINAL_LEAD_MS = 24 * HOUR_MS;
/** §27 S6 — one day before the grace window closes. */
export const GRACE_ENDING_LEAD_MS = 24 * HOUR_MS;
/** §27 S10 — "+7 d / +30 d only (a paying customer already knows the product)". */
export const SUBSCRIPTION_FOLLOWUP_7D_MS = 7 * DAY_MS;
export const SUBSCRIPTION_FOLLOWUP_30D_MS = 30 * DAY_MS;

/**
 * One identifier per step of §26/§27. T1, S1, S2 and S8 are NOT here:
 * they are consequences of an action someone just took (starting a trial,
 * a payment being approved, a proof being uploaded, a cancellation being
 * recorded) and are emitted inside that action's own transaction, not by a
 * clock. Everything a CLOCK decides lives in this file.
 */
export type LifecycleStepId =
  // --- §26 trial
  | 'trial_ending_soon' // T2
  | 'trial_expired' // T3
  | 'trial_followup_3d' // T4
  | 'trial_followup_14d' // T5
  | 'trial_reactivation_45d' // T6
  // --- §27 subscription
  | 'subscription_renewal_due' // S3
  | 'subscription_renewal_tomorrow' // S4
  | 'subscription_grace_started' // S5
  | 'subscription_grace_ending' // S6
  | 'subscription_expired' // S7
  | 'subscription_cancelled' // S9
  | 'subscription_followup_7d' // S10a
  | 'subscription_followup_30d'; // S10b

export type LifecycleSequence = 'trial' | 'subscription';

export interface DueLifecycleStep {
  readonly step: LifecycleStepId;
  readonly sequence: LifecycleSequence;
  /** When this step fell due. Always `<= now` for a returned step. */
  readonly dueAt: Date;
  /**
   * The immutable instant the step is anchored to — what makes its dedupe
   * key stable across ticks and different across genuine recurrences.
   */
  readonly anchorAt: Date;
  /**
   * §26 T5/T6 — "the org has content (≥1 course or ≥1 student)". Content
   * is a database question, so this file only FLAGS the requirement; the
   * service answers it, and only when a flagged step is otherwise due (so
   * the extra query is never paid on the ordinary tick).
   */
  readonly requiresContent: boolean;
}

export interface LifecycleEvaluationInput {
  readonly subscription: EffectiveStatusInput;
  /**
   * `effectiveAt` of a recorded `trial`-kind cancellation, or null. A
   * trial cancellation is immediate, so this IS the instant the site went
   * offline and therefore T3's anchor.
   */
  readonly trialCancelledAt: Date | null;
  /** `effectiveAt` of a recorded `paid`-kind cancellation, or null. */
  readonly paidCancelledAt: Date | null;
}

function isWithinWindow(step: LifecycleStepId, dueAt: Date, now: Date): boolean {
  const lateness = now.getTime() - dueAt.getTime();
  const horizon = SHORT_NOTICE_STEPS.has(step)
    ? LIFECYCLE_SHORT_NOTICE_LATENESS_MS
    : LIFECYCLE_STEP_MAX_LATENESS_MS;
  return lateness >= 0 && lateness <= horizon;
}

function offset(from: Date, ms: number): Date {
  return new Date(from.getTime() + ms);
}

/**
 * Every step of §26/§27 that is due for this organisation at `now`,
 * ordered by `dueAt` ascending.
 *
 * The ordering is not cosmetic: on a tick where a long outage left two
 * steps of the same sequence due at once, the customer must read them in
 * the order the events happened (§27's grace-then-expiry, never the
 * reverse). Emitting in `dueAt` order is what guarantees that.
 */
export function evaluateLifecycleSteps(
  input: LifecycleEvaluationInput,
  now: Date,
): readonly DueLifecycleStep[] {
  const due: DueLifecycleStep[] = [];
  const { subscription, trialCancelledAt, paidCancelledAt } = input;
  const effective = resolveEffectiveSubscriptionStatus(subscription, now).effectiveStatus;
  /** §26 T4–T6 / §27 S10: "only if no plan was chosen and no cancellation was recorded". */
  const anyCancellationRecorded = trialCancelledAt !== null || paidCancelledAt !== null;

  const push = (
    step: LifecycleStepId,
    sequence: LifecycleSequence,
    dueAt: Date,
    anchorAt: Date,
    requiresContent = false,
  ): void => {
    if (isWithinWindow(step, dueAt, now)) {
      due.push({ step, sequence, dueAt, anchorAt, requiresContent });
    }
  };

  // ---- §26 trial -----------------------------------------------------
  //
  // `trialEndsAt` is preserved by `markTrialExpired` and
  // `markTrialCancelled` precisely so it stays the historical record of
  // the trial — which is exactly what makes it a safe anchor here. A row
  // that never had a trial has none, and gets no trial step ever.
  const trialEndsAt = subscription.trialEndsAt;
  if (trialEndsAt) {
    // T2 — `trialEndsAt − 24 h`, and only while the trial is genuinely
    // still running. The status condition, not the horizon, is what stops
    // "your trial ends tomorrow" arriving after it already ended.
    if (effective === 'trialing' && !anyCancellationRecorded) {
      push(
        'trial_ending_soon',
        'trial',
        offset(trialEndsAt, -TRIAL_ENDING_SOON_LEAD_MS),
        trialEndsAt,
      );
    }

    // T3 — at expiry. A CANCELLED trial gets this one too (§26: "their
    // site goes offline too"), anchored on the cancellation's own
    // effective instant, because that is when it actually went dark.
    const cancelledTrial = effective === 'cancelled' && trialCancelledAt !== null;
    if (effective === 'trial_expired' || cancelledTrial) {
      const anchor = cancelledTrial ? trialCancelledAt! : trialEndsAt;
      push('trial_expired', 'trial', anchor, anchor);
    }

    // T4/T5/T6 — the conditional tail. `effective === 'trial_expired'`
    // IS the "no plan was chosen" test: any activation moves the row to
    // `active` (and a later paid lapse to `expired`), so the sequence
    // stops itself without anything being cancelled. A cancelled trial
    // never reaches here at all.
    if (effective === 'trial_expired' && !anyCancellationRecorded) {
      push(
        'trial_followup_3d',
        'trial',
        offset(trialEndsAt, TRIAL_FOLLOWUP_3D_MS),
        trialEndsAt,
      );
      push(
        'trial_followup_14d',
        'trial',
        offset(trialEndsAt, TRIAL_FOLLOWUP_14D_MS),
        trialEndsAt,
        true,
      );
      push(
        'trial_reactivation_45d',
        'trial',
        offset(trialEndsAt, TRIAL_REACTIVATION_45D_MS),
        trialEndsAt,
        true,
      );
    }
  }

  // ---- §27 subscription ----------------------------------------------
  const currentPeriodEnd = subscription.currentPeriodEnd;
  const graceEndsAt = resolveGraceEndsAt(subscription);

  // S3/S4 — renewal lead time. Conditioned on the period still being
  // live, which is also the "if still unpaid" of S4: a renewal moves
  // `currentPeriodEnd` forward, so the old anchor stops being due and the
  // new one is not due yet.
  if (effective === 'active' && currentPeriodEnd && !subscription.cancelAtPeriodEnd) {
    push(
      'subscription_renewal_due',
      'subscription',
      offset(currentPeriodEnd, -RENEWAL_REMINDER_LEAD_MS),
      currentPeriodEnd,
    );
    push(
      'subscription_renewal_tomorrow',
      'subscription',
      offset(currentPeriodEnd, -RENEWAL_FINAL_LEAD_MS),
      currentPeriodEnd,
    );
  }

  // S5/S6 — the grace window. S5 is anchored on the PERIOD END (the event
  // that opened the window) and S6 on the grace end (the event it warns
  // about), so the two can never collide on one key.
  if (effective === 'grace_period' && currentPeriodEnd) {
    push(
      'subscription_grace_started',
      'subscription',
      currentPeriodEnd,
      currentPeriodEnd,
    );
    if (graceEndsAt) {
      push(
        'subscription_grace_ending',
        'subscription',
        offset(graceEndsAt, -GRACE_ENDING_LEAD_MS),
        graceEndsAt,
      );
    }
  }

  // S7 — expiry. Note that S5's condition is FALSE here, so a sweep that
  // slept through an entire grace window emits only S7: telling someone
  // their site is in a grace period that has already closed would be a
  // lie, and the ordering §27 asks for is preserved by never sending the
  // earlier message late rather than by sorting.
  if (effective === 'expired' && graceEndsAt) {
    push('subscription_expired', 'subscription', graceEndsAt, graceEndsAt);

    // S10 — the two post-expiry follow-ups, same conditions as T4–T6.
    if (!anyCancellationRecorded) {
      push(
        'subscription_followup_7d',
        'subscription',
        offset(graceEndsAt, SUBSCRIPTION_FOLLOWUP_7D_MS),
        graceEndsAt,
      );
      push(
        'subscription_followup_30d',
        'subscription',
        offset(graceEndsAt, SUBSCRIPTION_FOLLOWUP_30D_MS),
        graceEndsAt,
      );
    }
  }

  // S9 — a paid cancellation becoming effective. Anchored on the recorded
  // `effectiveAt` rather than on `currentPeriodEnd`: that row is the
  // customer's own decision and never moves, whereas the subscription's
  // period columns are rewritten by the next purchase.
  if (effective === 'cancelled' && paidCancelledAt !== null) {
    push('subscription_cancelled', 'subscription', paidCancelledAt, paidCancelledAt);
  }

  return due.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
}

/**
 * The `tenant_lifecycle_state.phase` this organisation is in at `now` —
 * the durable, human-readable record the retention work (C6) and the
 * Lifecycle panel read. Never the dedupe mechanism (one column cannot
 * remember thirteen steps); purely observability.
 *
 * `cancelled` is deliberately resolved through the CANCELLATION RECORD
 * rather than the status alone: `markTrialCancelled` and
 * `markCancelledAtPeriodEnd` both write the same `cancelled` status, and
 * which of the two happened decides which retention window (§31) the
 * organisation is in. `subscription_cancellations.kind` is the only thing
 * that tells them apart.
 */
export function resolveLifecyclePhase(
  input: LifecycleEvaluationInput,
  now: Date,
): {
  readonly phase: string;
  readonly origin: string | null;
  readonly anchorAt: Date | null;
} {
  const { subscription, trialCancelledAt, paidCancelledAt } = input;
  const effective = resolveEffectiveSubscriptionStatus(subscription, now).effectiveStatus;
  switch (effective) {
    case 'trial_expired':
      return {
        phase: 'trial_sequence',
        origin: 'trial',
        anchorAt: subscription.trialEndsAt ?? null,
      };
    case 'cancelled':
      if (trialCancelledAt) {
        return { phase: 'trial_sequence', origin: 'trial', anchorAt: trialCancelledAt };
      }
      return { phase: 'paid_sequence', origin: 'paid', anchorAt: paidCancelledAt };
    case 'grace_period':
    case 'expired':
      return {
        phase: 'paid_sequence',
        origin: 'paid',
        anchorAt: resolveGraceEndsAt(subscription),
      };
    default:
      return { phase: 'active', origin: null, anchorAt: null };
  }
}
