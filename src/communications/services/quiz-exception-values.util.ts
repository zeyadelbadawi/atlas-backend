/**
 * The values every learner-exception communication carries, built in ONE
 * place (W-EXC).
 *
 * Three events describe the same `QuizStudentOverride` row at three
 * moments — granted, activated, revoked — and two different services emit
 * them: `QuizReviewService` (a reviewer's request) and
 * `QuizExceptionActivationService` (a sweep). If each built its own values
 * bag the learner would be told "1.5× the usual time limit" by one message
 * and something subtly different by the next, about the same
 * accommodation. Everything derived from the row lives here.
 *
 * Deliberately pure and free of Nest: it is the decision this workstream
 * most needs pinned by a unit test, and a decision that needs a module to
 * be exercised does not get tested at the boundaries.
 */

/** The row fields every message reads, plus the two names its copy needs. */
export interface QuizExceptionFacts {
  readonly overrideId: string;
  readonly quizId: string;
  readonly quizTitle: string;
  readonly courseId: string;
  /** Prisma `Decimal(4,2)` in any of the shapes it arrives as. */
  readonly timeMultiplier: string | number | { toString(): string };
  readonly extraAttempts: number;
  readonly availableFrom: Date | null;
  readonly availableUntil: Date | null;
}

/**
 * IS THIS EXCEPTION USABLE YET?
 *
 * The whole active-vs-scheduled decision, in one line, so that the email
 * copy, the in-app copy variant and the activation sweep can never
 * disagree about it:
 *
 *   - no `availableFrom` at all        → active (it applies immediately);
 *   - `availableFrom` at or before now → active (its window has opened);
 *   - `availableFrom` after now        → SCHEDULED.
 *
 * The boundary instant itself counts as ACTIVE, matching the engine: an
 * attempt started exactly at `availableFrom` is inside the window, so a
 * message that called that instant "scheduled" would contradict the page
 * the learner is looking at.
 */
export function isScheduled(availableFrom: Date | null, at: Date): boolean {
  return availableFrom !== null && availableFrom.getTime() > at.getTime();
}

/**
 * `2026-09-30 14:00 UTC` — the instant a window opens or closes.
 *
 * UTC and spelled out, rather than a bare date: an exception is a
 * DEADLINE-shaped fact, so an hour matters, and a naked local-looking
 * time in an email that crosses time zones is how a learner misses a
 * window by an afternoon. The academy's own timezone is not reliably
 * known at emit time, so the message states the zone it really used
 * rather than implying one it did not.
 */
export function utcLabel(value: Date | null): string {
  if (!value) return '';
  return `${value.toISOString().slice(0, 10)} ${value.toISOString().slice(11, 16)} UTC`;
}

/** `1.50` (Prisma's Decimal spelling) → `1.5`; anything unreadable → `1`. */
export function multiplierLabel(value: QuizExceptionFacts['timeMultiplier']): string {
  const asNumber = Number(typeof value === 'object' ? value.toString() : value);
  return Number.isFinite(asNumber) ? String(asNumber) : '1';
}

/** What the row IS — shared by all three messages. */
function describe(facts: QuizExceptionFacts): Record<string, unknown> {
  return {
    quizId: facts.quizId,
    quizTitle: facts.quizTitle,
    courseId: facts.courseId,
    timeMultiplier: multiplierLabel(facts.timeMultiplier),
    extraAttempts: facts.extraAttempts,
    availableFromLabel: utcLabel(facts.availableFrom),
    availableUntilLabel: utcLabel(facts.availableUntil),
  };
}

/**
 * `assessment.exception.granted`.
 *
 * `grantedAt` is the transition instant, computed ONCE by the producer
 * and used for both the dedupe key and the active/scheduled decision, so
 * a retry of the same request produces a byte-identical key and the same
 * copy — and an EDIT, which moves the instant, is correctly a new thing
 * to tell someone about.
 */
export function grantedValues(
  facts: QuizExceptionFacts,
  grantedAt: Date,
): Record<string, unknown> {
  return {
    ...describe(facts),
    grantedAtMs: grantedAt.getTime(),
    scheduled: isScheduled(facts.availableFrom, grantedAt),
  };
}

/**
 * `assessment.exception.activated`.
 *
 * Keyed on `availableFrom` itself — the instant that transitioned — and
 * NOT on the sweep's tick. That is the single property that makes a job
 * running every five minutes forever send one message: the instant does
 * not move, so the key does not move, so the unique index on
 * `(recipient_user_id, dedupe_key)` rejects every repeat.
 */
export function activatedValues(facts: QuizExceptionFacts): Record<string, unknown> {
  return {
    ...describe(facts),
    availableFromMs: facts.availableFrom ? facts.availableFrom.getTime() : 0,
  };
}

/** `assessment.exception.revoked`, keyed on the instant it was taken away. */
export function revokedValues(
  facts: QuizExceptionFacts,
  revokedAt: Date,
): Record<string, unknown> {
  return {
    ...describe(facts),
    revokedAtMs: revokedAt.getTime(),
  };
}
