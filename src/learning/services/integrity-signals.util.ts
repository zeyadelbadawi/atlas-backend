/**
 * Explainable integrity signals (P5).
 *
 * The event timeline records what the browser reported. A reviewer needs
 * the few facts worth a look, each with the numbers behind it and the
 * evidence that produced it — not a verdict. This module turns one
 * attempt's events into those facts, server-side, with fixed and
 * documented rules (Reports/ASSESSMENT_INTEGRITY.md):
 *
 *   - NO SCORE, NO PROBABILITY. A signal is "worth a look" (`review`) or
 *     context (`info`); Atlas never says whether anyone cheated.
 *   - EVERY SIGNAL CARRIES ITS EVIDENCE: the event ids it was built from,
 *     so the timeline can show exactly those rows.
 *   - EVERY SIGNAL HAS INNOCENT EXPLANATIONS, listed in the reviewer's UI
 *     next to it (notifications, a second monitor, a dropped connection,
 *     pasting one's own text, a browser without full screen…).
 *   - ONLY WHAT THE BROWSER CAN SEE OF THIS PAGE. A second device, another
 *     person in the room or an assistant on a phone produce no events; no
 *     rule here can detect them, and the evaluation says so.
 *
 * Durations come from SERVER time where it exists (`serverAt` is the
 * batch's arrival), falling back to the client's clock only to pair a
 * hidden/visible or exit/enter within one batch — the client clock is
 * never used for order or escalation (that is `decideIntegrity`'s rule).
 */
import type { QuizAttemptEventType } from '@prisma/client';

/** Intervals shorter than this are not reported (a notification, an alt-tab flick). */
export const SIGNAL_MIN_INTERVAL_SECONDS = 2;
/** Time away (tab hidden) worth a look: this much in total… */
export const AWAY_REVIEW_TOTAL_SECONDS = 30;
/** …or this many separate times. */
export const AWAY_REVIEW_OCCURRENCES = 3;
/** Focus lost while the page stayed visible (another window on top) worth a look in total. */
export const FOCUS_REVIEW_TOTAL_SECONDS = 60;
/** Out of a required full screen worth a look: this much in total… */
export const FULLSCREEN_REVIEW_TOTAL_SECONDS = 30;
/** …or this many separate exits. */
export const FULLSCREEN_REVIEW_OCCURRENCES = 2;
/**
 * No batch from the browser for this long while the attempt was open. The
 * client sends a heartbeat every 60 s and flushes every 2 s, so three
 * missed heartbeats is well past normal jitter.
 */
export const CONNECTION_GAP_SECONDS = 180;

export type IntegritySignalKey =
  | 'time_away'
  | 'focus_lost'
  | 'fullscreen_left'
  | 'fullscreen_never_entered'
  | 'fullscreen_unavailable'
  | 'paste_without_copy'
  | 'paste_after_copy'
  | 'copy'
  | 'print'
  | 'connection_gap';

/**
 * Technical interruptions (the connection, the browser's abilities) are
 * kept apart from behaviour, so a reviewer never reads a dropped Wi-Fi or
 * an iPhone as conduct.
 */
const TECHNICAL_SIGNALS: ReadonlySet<IntegritySignalKey> = new Set<IntegritySignalKey>([
  'connection_gap',
  'fullscreen_unavailable',
]);

export interface IntegritySignal {
  readonly key: IntegritySignalKey;
  /** `review`: worth a reviewer's look. `info`: context. Never a verdict. */
  readonly level: 'review' | 'info';
  /** `technical`: an interruption or browser limit, not conduct. */
  readonly category: 'behaviour' | 'technical';
  readonly occurrences: number;
  /** Total and longest interval, for duration signals. */
  readonly totalSeconds?: number;
  readonly longestSeconds?: number;
  /** For `fullscreen_unavailable`: what the browser reported. */
  readonly reasons?: readonly string[];
  /** The events this signal was built from, in timeline order. */
  readonly eventIds: readonly string[];
}

export interface SignalEvent {
  readonly id: string;
  readonly type: QuizAttemptEventType;
  readonly serverAt: Date;
  readonly clientAt: Date | null;
  readonly payload?: unknown;
}

export interface SignalInput {
  readonly events: readonly SignalEvent[];
  readonly startedAt: Date;
  /** Submission time, or "now" for an attempt still open. */
  readonly endedAt: Date;
  readonly integrityMode: 'off' | 'monitor' | 'warn' | 'strict';
  readonly requireFullscreen: boolean;
}

interface Interval {
  readonly seconds: number;
  readonly eventIds: readonly string[];
}

/**
 * Seconds between two events of one attempt. Server time first; when both
 * arrived in the same batch (same `serverAt`), the client clock is the
 * only measure of the gap between them — used for that one purpose.
 */
function secondsBetween(from: SignalEvent, to: SignalEvent | Date): number {
  if (to instanceof Date)
    return Math.max(0, (to.getTime() - from.serverAt.getTime()) / 1000);
  const server = (to.serverAt.getTime() - from.serverAt.getTime()) / 1000;
  if (server > 0) return server;
  if (from.clientAt && to.clientAt) {
    return Math.max(0, (to.clientAt.getTime() - from.clientAt.getTime()) / 1000);
  }
  return 0;
}

/** Pairs each `open` event with the next `close` (or the end of the attempt). */
function intervals(
  events: readonly SignalEvent[],
  open: QuizAttemptEventType,
  close: QuizAttemptEventType,
  endedAt: Date,
): Interval[] {
  const result: Interval[] = [];
  let current: SignalEvent | null = null;
  for (const event of events) {
    if (event.type === open && !current) current = event;
    else if (event.type === close && current) {
      result.push({
        seconds: secondsBetween(current, event),
        eventIds: [current.id, event.id],
      });
      current = null;
    }
  }
  if (current)
    result.push({ seconds: secondsBetween(current, endedAt), eventIds: [current.id] });
  return result.filter((interval) => interval.seconds >= SIGNAL_MIN_INTERVAL_SECONDS);
}

function durationSignal(
  key: IntegritySignalKey,
  found: readonly Interval[],
  review: (total: number, occurrences: number) => boolean,
): Omit<IntegritySignal, 'category'> | null {
  if (found.length === 0) return null;
  const total = Math.round(found.reduce((sum, interval) => sum + interval.seconds, 0));
  const longest = Math.round(Math.max(...found.map((interval) => interval.seconds)));
  return {
    key,
    level: review(total, found.length) ? 'review' : 'info',
    occurrences: found.length,
    totalSeconds: total,
    longestSeconds: longest,
    eventIds: found.flatMap((interval) => interval.eventIds),
  };
}

/** Was this blur followed by the tab being hidden before focus came back? */
function overlapsHidden(blur: SignalEvent, events: readonly SignalEvent[]): boolean {
  // A blur immediately followed (before its focus) by the tab being hidden
  // is the same moment as "time away", which already reports it.
  const index = events.indexOf(blur);
  for (let i = index + 1; i < events.length; i += 1) {
    if (events[i].type === 'focus') return false;
    if (events[i].type === 'visibility_hidden') return true;
  }
  return false;
}

export function deriveIntegritySignals(input: SignalInput): IntegritySignal[] {
  return deriveSignals(input).map((signal) => ({
    ...signal,
    category: TECHNICAL_SIGNALS.has(signal.key) ? 'technical' : 'behaviour',
  }));
}

function deriveSignals(input: SignalInput): Omit<IntegritySignal, 'category'>[] {
  if (input.integrityMode === 'off') return [];
  const events = [...input.events].sort(
    (a, b) => a.serverAt.getTime() - b.serverAt.getTime(),
  );
  const signals: Omit<IntegritySignal, 'category'>[] = [];
  const push = (signal: Omit<IntegritySignal, 'category'> | null) => {
    if (signal) signals.push(signal);
  };

  // Tab hidden (another tab, another app, the screen locked).
  push(
    durationSignal(
      'time_away',
      intervals(events, 'visibility_hidden', 'visibility_visible', input.endedAt),
      (total, count) =>
        total >= AWAY_REVIEW_TOTAL_SECONDS || count >= AWAY_REVIEW_OCCURRENCES,
    ),
  );

  // Focus lost while the page stayed visible (a window on top, side by side).
  const focusEvents = events.filter(
    (event) => event.type !== 'blur' || !overlapsHidden(event, events),
  );
  push(
    durationSignal(
      'focus_lost',
      intervals(focusEvents, 'blur', 'focus', input.endedAt),
      (total) => total >= FOCUS_REVIEW_TOTAL_SECONDS,
    ),
  );

  if (input.requireFullscreen) {
    const unavailable = events.filter((event) => event.type === 'fullscreen_unavailable');
    const entered = events.some((event) => event.type === 'fullscreen_enter');
    push(
      durationSignal(
        'fullscreen_left',
        intervals(events, 'fullscreen_exit', 'fullscreen_enter', input.endedAt),
        (total, count) =>
          total >= FULLSCREEN_REVIEW_TOTAL_SECONDS ||
          count >= FULLSCREEN_REVIEW_OCCURRENCES,
      ),
    );
    if (unavailable.length > 0) {
      const reasons = [
        ...new Set(
          unavailable
            .map((event) => (event.payload as { reason?: unknown } | null)?.reason)
            .filter((reason): reason is string => typeof reason === 'string'),
        ),
      ];
      signals.push({
        key: 'fullscreen_unavailable',
        level: 'info',
        occurrences: unavailable.length,
        reasons,
        eventIds: unavailable.map((event) => event.id),
      });
    } else if (!entered) {
      signals.push({
        key: 'fullscreen_never_entered',
        level: 'review',
        occurrences: 1,
        eventIds: [],
      });
    }
  }

  // Clipboard: pasting text that was not copied inside this attempt is the
  // notable case; moving one's own text from answer to answer is not.
  const pastes = events.filter((event) => event.type === 'paste');
  const withoutCopy: SignalEvent[] = [];
  const afterCopy: SignalEvent[] = [];
  for (const paste of pastes) {
    const copiedBefore = events.some(
      (event) =>
        (event.type === 'copy' || event.type === 'cut') &&
        event.serverAt.getTime() <= paste.serverAt.getTime() &&
        events.indexOf(event) < events.indexOf(paste),
    );
    (copiedBefore ? afterCopy : withoutCopy).push(paste);
  }
  if (withoutCopy.length > 0) {
    signals.push({
      key: 'paste_without_copy',
      level: 'review',
      occurrences: withoutCopy.length,
      eventIds: withoutCopy.map((event) => event.id),
    });
  }
  if (afterCopy.length > 0) {
    signals.push({
      key: 'paste_after_copy',
      level: 'info',
      occurrences: afterCopy.length,
      eventIds: afterCopy.map((event) => event.id),
    });
  }
  const copies = events.filter((event) => event.type === 'copy' || event.type === 'cut');
  if (copies.length > 0) {
    signals.push({
      key: 'copy',
      level: 'info',
      occurrences: copies.length,
      eventIds: copies.map((event) => event.id),
    });
  }

  const prints = events.filter((event) => event.type === 'print');
  if (prints.length > 0) {
    signals.push({
      key: 'print',
      level: 'review',
      occurrences: prints.length,
      eventIds: prints.map((event) => event.id),
    });
  }

  // Silence: no batch from the browser for a long stretch of an open
  // attempt (tab closed, device asleep, offline, or events blocked).
  const batchTimes = [
    input.startedAt.getTime(),
    ...new Set(events.map((event) => event.serverAt.getTime())),
    input.endedAt.getTime(),
  ].sort((a, b) => a - b);
  const gaps: Interval[] = [];
  for (let i = 1; i < batchTimes.length; i += 1) {
    const seconds = (batchTimes[i] - batchTimes[i - 1]) / 1000;
    if (seconds >= CONNECTION_GAP_SECONDS) {
      const after = events.find((event) => event.serverAt.getTime() === batchTimes[i]);
      gaps.push({ seconds, eventIds: after ? [after.id] : [] });
    }
  }
  push(durationSignal('connection_gap', gaps, () => false));

  return signals;
}
