/**
 * The HOSTED-VIDEO RETENTION evaluator — P64 Communications C6, the pure
 * half of `docs/communications/COMMUNICATIONS_AND_LIFECYCLE_PLAN.md` §31
 * (retention windows, the W1–W4 warning sequence, the D completion mail)
 * and §32 (the worked timeline).
 *
 * THIS FILE DECIDES WHEN A PAYING CUSTOMER'S VIDEO IS DESTROYED. Every
 * other file in this workstream can be wrong and be fixed; this one being
 * wrong is unrecoverable, because the bytes do not come back. It is
 * therefore pure — no I/O, no injected services, no `new Date()` — for the
 * same reason `lifecycle-steps.util.ts` is: `now` is always an argument, so
 * every boundary in it can be stood on from a unit test without a database
 * and without sleeping.
 *
 * NOTHING IS EVER SCHEDULED AHEAD. Exactly as C5: the sweep asks "what is
 * due for this organisation at this instant?" every tick and acts on the
 * answer. A customer who pays stops satisfying the condition on the next
 * tick, so there is no queue of future deletions to revoke. (The per-ASSET
 * BullMQ jobs are the one thing that does sit in a queue, for minutes, and
 * each of them re-asks this same question at execution time — see
 * `VideoRetentionDeletionService`.)
 *
 * ---------------------------------------------------------------------
 * THE THREE GUARDS, AND WHY EACH EXISTS
 * ---------------------------------------------------------------------
 *
 * (1) THE LATENESS HORIZON — a step is due inside a WINDOW,
 *     `[dueAt, dueAt + horizon]`, never "at any time after `dueAt`".
 *
 *     `trial_expired` and `expired` are TERMINAL: once true they are true
 *     forever. Without a horizon, the first tick after someone sets the
 *     flag to `on` would find every organisation that ever lapsed to be
 *     simultaneously past W1, past W2, past W3, past W4 and past its
 *     deletion date — and would delete all of their video, in one tick,
 *     with no warning ever having been sent. Production today is roughly
 *     sixteen of seventeen organisations in `trial_expired`, most of them
 *     lapsed months ago. This is not a hypothetical; it is the difference
 *     between a rollout and the permanent destruction of every customer's
 *     content. C5 found the same trap for emails and answered it the same
 *     way; here the stakes are bytes rather than a stale reminder.
 *
 *     The cost is stated rather than hidden: a sweep outage longer than
 *     the horizon makes a step SKIPPED, not delayed. For a warning that
 *     costs one nudge. For the deletion it costs the reclaim — that
 *     organisation's video is then never deleted by this automation at
 *     all, and a deliberate operator backfill (which this workstream does
 *     not provide) would be needed. That asymmetry is intentional: not
 *     reclaiming storage is an invoice, deleting unwarned is a lawsuit.
 *
 * (2) THE WARNING PRECONDITION — deletion is due only if ALL FOUR
 *     warnings were actually emitted for THIS anchor.
 *
 *     The horizon alone protects the first tick. This protects everything
 *     else, and it is the guard that makes the feature defensible rather
 *     than merely careful: Atlas deletes video only from customers who
 *     received the complete four-notice sequence this plan promises them.
 *     A tenant the flag was switched on halfway through, a tenant whose
 *     W2 fell inside a sweep outage, a tenant whose organisation was
 *     suspended for a fortnight — none of them are deletable. They fail
 *     safe, silently, forever, and the Platform Owner has to decide about
 *     them deliberately.
 *
 *     Proof is the OUTBOX ROW, not a boolean someone remembered to set:
 *     the four rows carry the same anchor in their dedupe keys, so
 *     "were they warned" and "were they warned about THIS deletion date"
 *     are the same question. §33 prunes the outbox at 90 days and W1 is
 *     only 30 days before deletion, so the evidence always outlives the
 *     decision.
 *
 * (3) THE HOLD — a legal hold, or an open support case, and nothing is
 *     due at all.
 *
 *     Note what this does and does not do. It SUSPENDS the sequence; it
 *     does not rewind the clock (that would need a column recording
 *     accumulated held time, and no such column exists — see the
 *     workstream report). The interaction with (1) is what makes the
 *     simpler behaviour safe: a hold held longer than the horizon does not
 *     "release into" a mass deletion, because every step it covered has
 *     aged out of its own window. A released hold is quiet, not explosive.
 *
 * ---------------------------------------------------------------------
 * DEDUPE. As C5: `lifecycle_<step>:<organizationId>:<anchor>`, where the
 * anchor is the IMMUTABLE instant the timing derives from. A tick fifteen
 * minutes later re-derives a byte-identical string and the
 * `(recipient_user_id, dedupe_key)` unique index rejects it; a tenant who
 * pays and later lapses again derives a different anchor and is correctly
 * treated as the new occurrence it is.
 */
import {
  resolveLifecyclePhase,
  type LifecycleEvaluationInput,
} from '../../plans/utils/lifecycle-steps.util';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * §31 — hosted video is deleted this long after the anchor.
 *
 * 90 days for a formerly-TRIALING tenant: a three-day trial's uploads are
 * evaluation material nobody paid for, and a full quarter of silence is
 * generous against the industry's usual thirty.
 *
 * 180 days for a formerly-PAID tenant: they paid. Six months of silence is
 * the conventional churn threshold, it covers a sabbatical or a budget
 * cycle, and the storage bill for half a year is small next to the
 * goodwill cost of deleting a returning customer's course library.
 */
export const RETENTION_WINDOW_TRIAL_MS = 90 * DAY_MS;
export const RETENTION_WINDOW_PAID_MS = 180 * DAY_MS;

/** §31 — how far BEFORE the deletion date each warning is sent. */
export const RETENTION_W1_LEAD_MS = 30 * DAY_MS;
export const RETENTION_W2_LEAD_MS = 14 * DAY_MS;
export const RETENTION_W3_LEAD_MS = 7 * DAY_MS;
export const RETENTION_W4_LEAD_MS = 24 * HOUR_MS;

/**
 * How late W1–W3 may still be sent. Two days, matching
 * `LIFECYCLE_STEP_MAX_LATENESS_MS` deliberately: against a sweep every 15
 * minutes, eight ticks in a row would have to be missed, and the same
 * horizon in both sequences means one number to reason about rather than
 * two that can drift.
 */
export const RETENTION_STEP_MAX_LATENESS_MS = 2 * DAY_MS;

/**
 * How late W4 — the "in 24 hours" last call — may still be sent.
 *
 * Six hours, C5's own short-notice horizon, for its reason: an email
 * saying "tomorrow" that arrives twenty-three hours late is not late, it
 * is false. A W4 missed entirely makes the tenant undeletable by guard
 * (2), which is the correct way for this to fail.
 */
export const RETENTION_SHORT_NOTICE_LATENESS_MS = 6 * HOUR_MS;

/**
 * How late the DELETION itself may still be performed — seven days.
 *
 * Longer than a warning's horizon because missing this window is not a
 * missed nudge: the organisation is then never deleted at all (guard (1)).
 * A week means an entire week of sweep outage, on top of the four warnings
 * having gone out on schedule, before the reclaim is abandoned.
 *
 * Deliberately NOT unbounded, and this is the single most important
 * constant in the workstream. Unbounded, the first `on` tick would delete
 * the hosted video of every organisation that has ever lapsed — in
 * production, roughly sixteen of seventeen, all at once, none of them
 * warned. The horizon is what makes enabling this a rollout instead of an
 * incident.
 */
export const RETENTION_DELETION_MAX_LATENESS_MS = 7 * DAY_MS;

export type RetentionOrigin = 'trial' | 'paid';

/** The four warnings of §31's W1–W4 table, plus the deletion itself. */
export type RetentionStepId =
  | 'retention_warning_30d' // W1 Notice
  | 'retention_warning_14d' // W2 Reminder
  | 'retention_warning_7d' // W3 Final warning
  | 'retention_warning_24h' // W4 Last call
  | 'retention_delete'; // the destructive step

/** W1–W4 in the order the customer receives them. */
export const RETENTION_WARNING_STEPS: readonly RetentionStepId[] = [
  'retention_warning_30d',
  'retention_warning_14d',
  'retention_warning_7d',
  'retention_warning_24h',
];

const WARNING_LEAD_MS: Readonly<Record<string, number>> = {
  retention_warning_30d: RETENTION_W1_LEAD_MS,
  retention_warning_14d: RETENTION_W2_LEAD_MS,
  retention_warning_7d: RETENTION_W3_LEAD_MS,
  retention_warning_24h: RETENTION_W4_LEAD_MS,
};

export interface DueRetentionStep {
  readonly step: RetentionStepId;
  /** When this step fell due. Always `<= now` for a returned step. */
  readonly dueAt: Date;
  /** The immutable instant the whole sequence is anchored to — the dedupe version. */
  readonly anchorAt: Date;
  readonly origin: RetentionOrigin;
  /** When the bytes go. Carried on every step because every warning names it. */
  readonly deletionAt: Date;
}

export interface RetentionEvaluationInput extends LifecycleEvaluationInput {
  /**
   * Guard (3). True when `tenant_lifecycle_state.legal_hold` is set or an
   * open support case exists for this organisation. Resolved by the
   * caller, because it is two database questions; answered here by
   * returning nothing at all.
   */
  readonly held: boolean;
  /**
   * Guard (2). Which of W1–W4 have an outbox row for THIS anchor. The
   * deletion step is withheld unless all four are present.
   */
  readonly warningsAlreadySent: ReadonlySet<RetentionStepId>;
}

export interface RetentionWindow {
  readonly origin: RetentionOrigin;
  readonly anchorAt: Date;
  readonly deletionAt: Date;
}

/** The retention window this organisation is in, or `null` if it is not inactive. */
export function resolveRetentionWindow(
  input: LifecycleEvaluationInput,
  now: Date,
): RetentionWindow | null {
  const phase = resolveLifecyclePhase(input, now);
  if (!phase.anchorAt || phase.origin === null) return null;
  const origin: RetentionOrigin | null =
    phase.origin === 'trial' ? 'trial' : phase.origin === 'paid' ? 'paid' : null;
  if (!origin) return null;
  const windowMs =
    origin === 'trial' ? RETENTION_WINDOW_TRIAL_MS : RETENTION_WINDOW_PAID_MS;
  return {
    origin,
    anchorAt: phase.anchorAt,
    deletionAt: new Date(phase.anchorAt.getTime() + windowMs),
  };
}

function horizonFor(step: RetentionStepId): number {
  if (step === 'retention_delete') return RETENTION_DELETION_MAX_LATENESS_MS;
  if (step === 'retention_warning_24h') return RETENTION_SHORT_NOTICE_LATENESS_MS;
  return RETENTION_STEP_MAX_LATENESS_MS;
}

/** Guard (1), in one line. Everything else in this file feeds it. */
export function isWithinRetentionWindow(
  step: RetentionStepId,
  dueAt: Date,
  now: Date,
): boolean {
  const lateness = now.getTime() - dueAt.getTime();
  return lateness >= 0 && lateness <= horizonFor(step);
}

/**
 * Every retention step due for this organisation at `now`, earliest first.
 *
 * Ordering matters for the same reason it does in C5: after an outage that
 * left two warnings due at once the customer must read them in the order
 * the events happened. It matters more here, because the last entry in the
 * list can be the destructive one and it must never be acted on before the
 * warnings that precede it have been written.
 */
export function evaluateRetentionSteps(
  input: RetentionEvaluationInput,
  now: Date,
): readonly DueRetentionStep[] {
  // Guard (3) — a hold answers the whole question, not just the last step.
  if (input.held) return [];

  const window = resolveRetentionWindow(input, now);
  if (!window) return [];

  const due: DueRetentionStep[] = [];
  const base = {
    anchorAt: window.anchorAt,
    origin: window.origin,
    deletionAt: window.deletionAt,
  };

  for (const step of RETENTION_WARNING_STEPS) {
    const dueAt = new Date(window.deletionAt.getTime() - WARNING_LEAD_MS[step]);
    // A warning that falls due BEFORE the anchor itself is not a warning,
    // it is a bug in the window arithmetic. Cannot happen with the
    // constants above (the longest lead, 30 d, is far inside the shortest
    // window, 90 d), asserted here so a future edit that inverts them
    // fails closed rather than mailing people about a deletion that has
    // not been scheduled.
    if (dueAt.getTime() < window.anchorAt.getTime()) continue;
    if (isWithinRetentionWindow(step, dueAt, now)) {
      due.push({ step, dueAt, ...base });
    }
  }

  // Guard (2) — the destructive step, and the only place in this codebase
  // that may authorise it.
  const warnedInFull = RETENTION_WARNING_STEPS.every((step) =>
    input.warningsAlreadySent.has(step),
  );
  if (
    warnedInFull &&
    isWithinRetentionWindow('retention_delete', window.deletionAt, now)
  ) {
    due.push({ step: 'retention_delete', dueAt: window.deletionAt, ...base });
  }

  return due.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
}

/**
 * The widest span of anchor instants that can still produce ANY step at
 * `now`, per origin — the bound the candidate query uses so an
 * organisation that lapsed two years ago is never even fetched.
 *
 * Derived from the same constants the evaluator uses rather than restated,
 * so the query and the decision cannot drift apart.
 */
export function retentionCandidateAnchorRange(
  origin: RetentionOrigin,
  now: Date,
): { readonly earliest: Date; readonly latest: Date } {
  const windowMs =
    origin === 'trial' ? RETENTION_WINDOW_TRIAL_MS : RETENTION_WINDOW_PAID_MS;
  return {
    // Oldest anchor still inside the deletion horizon.
    earliest: new Date(now.getTime() - (windowMs + RETENTION_DELETION_MAX_LATENESS_MS)),
    // Newest anchor whose W1 has already fallen due.
    latest: new Date(now.getTime() - (windowMs - RETENTION_W1_LEAD_MS)),
  };
}
