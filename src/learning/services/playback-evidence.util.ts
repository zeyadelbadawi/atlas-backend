/**
 * How a playback heartbeat becomes EVIDENCE (master plan Phase 2 §D.6).
 *
 * THE PROBLEM THIS SOLVES. `lesson_progress.max_watched_ratio` gates
 * completion under the `watched_ratio` rule, so it is a number a learner
 * has an incentive to inflate — and the only thing reporting it is the
 * learner's own browser. A server that simply stored what the client sent
 * would be issuing certificates on the client's word.
 *
 * THE RULE. A heartbeat is credited with at most the WALL-CLOCK time that
 * has actually passed on the server since the previous one, times a
 * tolerance for fast playback. A client claiming it watched an hour in
 * ten seconds moves the counter by ten seconds and a bit, not by an hour.
 * Nothing here trusts a duration, a ratio or a delta the client computed.
 *
 * WHY 2.5x. Browsers offer playback up to 2x, and a heartbeat can be late
 * by a second or two on a slow network, so 2x plus headroom is the
 * smallest bound that never penalises a real learner. It is a bound, not
 * a measurement: someone watching at 2x genuinely did watch the content.
 *
 * WHY A PER-BEAT CAP. Without one, a client that goes quiet for an hour
 * and then reports a single beat would be credited with the entire hour.
 * The cap means a gap simply is not credited — which is correct, because
 * nobody was watching during it.
 *
 * Pure functions so the arithmetic is unit-testable without a database,
 * a clock or a request.
 */

/** Fast-playback tolerance. See the file comment. */
export const MAX_PLAYBACK_RATE = 2.5;

/** The most one heartbeat may ever credit, in seconds. Generous against the 20 s cadence, bounded against a long silence. */
export const MAX_CREDITED_DELTA_SECONDS = 120;

export interface PlaybackEvidenceState {
  readonly lastPositionSeconds: number;
  readonly watchedSeconds: number;
  readonly maxWatchedRatio: number;
  readonly lastActivityAt: Date | null;
}

export interface PlaybackHeartbeat {
  /** Where the player is now, as the client reports it. Used for RESUME only — never as evidence of watching. */
  readonly positionSeconds: number;
  readonly now: Date;
}

export interface PlaybackEvidenceUpdate {
  readonly lastPositionSeconds: number;
  readonly watchedSeconds: number;
  readonly maxWatchedRatio: number;
  readonly lastActivityAt: Date;
  /** How much this beat actually credited, for `course_progress.time_spent_seconds`. */
  readonly creditedSeconds: number;
}

/**
 * Applies one heartbeat.
 *
 * `positionSeconds` is clamped to the lesson's real duration, so a client
 * cannot report a position past the end of the video and drag the ratio
 * to 1 in a single beat.
 */
export function applyPlaybackHeartbeat(
  state: PlaybackEvidenceState,
  beat: PlaybackHeartbeat,
  durationSeconds: number | null,
): PlaybackEvidenceUpdate {
  const position = clampPosition(beat.positionSeconds, durationSeconds);

  // The first beat of a session credits nothing: there is no previous
  // observation to measure an interval against, and inventing one would
  // be exactly the unverified number this function exists to refuse.
  const elapsedSeconds = state.lastActivityAt
    ? (beat.now.getTime() - state.lastActivityAt.getTime()) / 1000
    : 0;

  const credited =
    elapsedSeconds > 0
      ? Math.min(
          Math.floor(elapsedSeconds * MAX_PLAYBACK_RATE),
          MAX_CREDITED_DELTA_SECONDS,
        )
      : 0;

  const watchedSeconds = state.watchedSeconds + credited;

  // The ratio is a HIGH-WATER MARK derived from credited evidence, not
  // from the reported position: rewinding must never take a completion
  // away, and skipping forward must never grant one.
  const ratio =
    durationSeconds && durationSeconds > 0
      ? Math.min(1, watchedSeconds / durationSeconds)
      : state.maxWatchedRatio;

  return {
    lastPositionSeconds: position,
    watchedSeconds,
    maxWatchedRatio: Math.max(state.maxWatchedRatio, round4(ratio)),
    lastActivityAt: beat.now,
    creditedSeconds: credited,
  };
}

function clampPosition(position: number, durationSeconds: number | null): number {
  if (!Number.isFinite(position) || position < 0) return 0;
  const rounded = Math.floor(position);
  if (durationSeconds && durationSeconds > 0) return Math.min(rounded, durationSeconds);
  return rounded;
}

/** Four decimal places — the column's own precision. Truncated, never rounded up: 0.8999 must not become 0.9 and pass a 90% gate. */
function round4(value: number): number {
  return Math.floor(value * 10000) / 10000;
}
