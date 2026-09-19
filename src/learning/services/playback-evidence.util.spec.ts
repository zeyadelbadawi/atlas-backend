/**
 * P64 Phase 2 — playback evidence (master plan Phase 2 §D.6, §N
 * "watched-ratio completion").
 *
 * WHY THESE TESTS EXIST. `max_watched_ratio` is the number a
 * `watched_ratio` lesson's completion — and therefore a certificate — is
 * gated on, and the only thing that can observe a video position is the
 * learner's own browser. Every case below is an attempt to make the
 * counter move further than the server can actually vouch for: a huge
 * claimed jump, a long silence reported as one beat, a position past the
 * end of the video, a negative position, a value that a rounding rule
 * would nudge over a 90% gate. If any of these stops being refused, Atlas
 * is issuing certificates on the client's word, and no integration test
 * would notice because the arithmetic would still look plausible.
 *
 * The complement is the bound in the other direction: a real learner
 * watching at 2x must never be under-credited, because a threshold nobody
 * can reach is a threshold that gets turned off.
 */
import {
  applyPlaybackHeartbeat,
  MAX_CREDITED_DELTA_SECONDS,
  MAX_PLAYBACK_RATE,
  type PlaybackEvidenceState,
} from './playback-evidence.util';

const T0 = new Date('2026-09-19T10:00:00.000Z');

/** Seconds after T0, as a Date — heartbeats are only ever compared to each other. */
function at(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1000);
}

function state(over: Partial<PlaybackEvidenceState> = {}): PlaybackEvidenceState {
  return {
    lastPositionSeconds: 0,
    watchedSeconds: 0,
    maxWatchedRatio: 0,
    lastActivityAt: T0,
    ...over,
  };
}

describe('applyPlaybackHeartbeat — what a beat may credit', () => {
  /*
   * THE FIRST BEAT. There is no previous observation to measure an
   * interval against, so there is nothing the server has witnessed yet.
   * Inventing an interval here would be exactly the unverified number
   * this function exists to refuse.
   */
  it('credits nothing on the first heartbeat of a session', () => {
    const result = applyPlaybackHeartbeat(
      state({ lastActivityAt: null, watchedSeconds: 0 }),
      { positionSeconds: 42, now: T0 },
      600,
    );

    expect(result.creditedSeconds).toBe(0);
    expect(result.watchedSeconds).toBe(0);
    expect(result.maxWatchedRatio).toBe(0);
    // The position is still recorded — it is the RESUME point, not evidence.
    expect(result.lastPositionSeconds).toBe(42);
    expect(result.lastActivityAt).toEqual(T0);
  });

  /*
   * THE CLAIMED JUMP. Ten seconds of wall clock passed; the client says
   * it is now an hour into the video. The credit is bounded by the clock,
   * not by the client's arithmetic.
   */
  it('credits only wall-clock × 2.5 however far the client claims it jumped', () => {
    const result = applyPlaybackHeartbeat(
      state({ lastPositionSeconds: 0, watchedSeconds: 0 }),
      { positionSeconds: 3600, now: at(10) },
      7200,
    );

    expect(result.creditedSeconds).toBe(25); // floor(10 × 2.5)
    expect(result.watchedSeconds).toBe(25);
    expect(result.lastPositionSeconds).toBe(3600); // resume point, unrelated to credit
  });

  /* The tolerance is a BOUND, not a measurement: 2x playback is real watching. */
  it('does not penalise a learner watching at 2x', () => {
    const wallClockSeconds = 20;
    const result = applyPlaybackHeartbeat(
      state(),
      { positionSeconds: wallClockSeconds * 2, now: at(wallClockSeconds) },
      600,
    );

    expect(result.creditedSeconds).toBe(wallClockSeconds * MAX_PLAYBACK_RATE);
    expect(result.creditedSeconds).toBeGreaterThanOrEqual(wallClockSeconds * 2);
  });

  /*
   * THE LONG SILENCE. A tab left open for an hour and then reporting a
   * single beat must not be credited with the hour — nobody was watching
   * during it.
   */
  it('caps one heartbeat at 120 s however long the client was silent', () => {
    const result = applyPlaybackHeartbeat(
      state({ watchedSeconds: 100 }),
      { positionSeconds: 3600, now: at(3600) },
      7200,
    );

    expect(result.creditedSeconds).toBe(MAX_CREDITED_DELTA_SECONDS);
    expect(result.creditedSeconds).toBe(120);
    expect(result.watchedSeconds).toBe(220);
  });

  it('credits the raw interval while it is under the per-beat cap', () => {
    // 40 s of silence × 2.5 = 100 s, below the 120 s cap, so the cap is
    // not what decides — proving the cap is a ceiling, not a flat rate.
    const result = applyPlaybackHeartbeat(
      state(),
      { positionSeconds: 40, now: at(40) },
      600,
    );
    expect(result.creditedSeconds).toBe(100);
  });

  /* A clock that went backwards (skew, a replayed beat) credits nothing rather than a negative. */
  it('credits nothing for a non-positive interval', () => {
    const result = applyPlaybackHeartbeat(
      state({ lastActivityAt: at(100), watchedSeconds: 50 }),
      { positionSeconds: 30, now: at(40) },
      600,
    );

    expect(result.creditedSeconds).toBe(0);
    expect(result.watchedSeconds).toBe(50);
  });
});

describe('applyPlaybackHeartbeat — the reported position', () => {
  it('clamps a position past the end of the video to the real duration', () => {
    const result = applyPlaybackHeartbeat(
      state(),
      { positionSeconds: 999_999, now: at(10) },
      600,
    );

    expect(result.lastPositionSeconds).toBe(600);
  });

  it('clamps a negative position to 0', () => {
    const result = applyPlaybackHeartbeat(
      state(),
      { positionSeconds: -120, now: at(10) },
      600,
    );
    expect(result.lastPositionSeconds).toBe(0);
  });

  it('clamps a NaN or infinite position to 0 rather than storing it', () => {
    for (const positionSeconds of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const result = applyPlaybackHeartbeat(
        state(),
        { positionSeconds, now: at(10) },
        600,
      );
      expect(result.lastPositionSeconds).toBe(0);
    }
  });

  it('floors a fractional position to whole seconds', () => {
    const result = applyPlaybackHeartbeat(
      state(),
      { positionSeconds: 12.9, now: at(10) },
      600,
    );
    expect(result.lastPositionSeconds).toBe(12);
  });

  it('leaves the position alone when the duration is unknown', () => {
    // Nothing to clamp against; the resume point is still worth keeping.
    const result = applyPlaybackHeartbeat(
      state(),
      { positionSeconds: 400, now: at(10) },
      null,
    );
    expect(result.lastPositionSeconds).toBe(400);
  });
});

describe('applyPlaybackHeartbeat — maxWatchedRatio', () => {
  /*
   * HIGH-WATER MARK. Rewinding to re-watch something is normal learner
   * behaviour and must never take a completion away. The ratio is derived
   * from credited evidence, which only grows, and is additionally floored
   * by the previous mark.
   */
  it('never lowers the mark when the learner rewinds', () => {
    const result = applyPlaybackHeartbeat(
      state({
        lastPositionSeconds: 540,
        watchedSeconds: 540,
        maxWatchedRatio: 0.9,
      }),
      { positionSeconds: 5, now: at(20) },
      600,
    );

    expect(result.lastPositionSeconds).toBe(5); // resume moves back
    expect(result.maxWatchedRatio).toBeGreaterThanOrEqual(0.9); // the mark does not
  });

  it('keeps a mark that the newly computed ratio would be lower than', () => {
    // A mark recorded earlier (e.g. before a duration correction) survives
    // a beat whose own arithmetic produces a much smaller number.
    const result = applyPlaybackHeartbeat(
      state({ watchedSeconds: 10, maxWatchedRatio: 0.75 }),
      { positionSeconds: 10, now: at(20) },
      100_000,
    );

    expect(result.maxWatchedRatio).toBe(0.75);
  });

  it('grows the mark from credited evidence, not from the reported position', () => {
    const result = applyPlaybackHeartbeat(
      state({ watchedSeconds: 290 }),
      // The client claims it is at the very end of a 600 s video…
      { positionSeconds: 600, now: at(4) },
      600,
    );

    // …but only 290 + floor(4 × 2.5) = 300 seconds were ever credited.
    expect(result.watchedSeconds).toBe(300);
    expect(result.maxWatchedRatio).toBe(0.5);
  });

  /*
   * TRUNCATED, NEVER ROUNDED. 0.89999 must stay below a 90% gate. A
   * `toFixed(4)`-style rounding here would hand out a completion the
   * learner did not earn.
   */
  it('truncates at four decimals rather than rounding up (0.89999 stays 0.8999)', () => {
    const result = applyPlaybackHeartbeat(
      state({ watchedSeconds: 89_979 }),
      { positionSeconds: 89_999, now: at(8) },
      100_000,
    );

    expect(result.watchedSeconds).toBe(89_999); // 89,979 + floor(8 × 2.5)
    expect(result.maxWatchedRatio).toBe(0.8999);
    expect(result.maxWatchedRatio).not.toBe(0.9);
    expect(result.maxWatchedRatio).toBeLessThan(0.9);
  });

  it('caps the ratio at 1 even when more was credited than the video is long', () => {
    const result = applyPlaybackHeartbeat(
      state({ watchedSeconds: 1200 }),
      { positionSeconds: 600, now: at(20) },
      600,
    );

    expect(result.maxWatchedRatio).toBe(1);
  });

  it('leaves the ratio untouched when the duration is null', () => {
    const result = applyPlaybackHeartbeat(
      state({ watchedSeconds: 100, maxWatchedRatio: 0.42 }),
      { positionSeconds: 130, now: at(20) },
      null,
    );

    expect(result.maxWatchedRatio).toBe(0.42);
    // Time is still credited — only the RATIO needs a duration.
    expect(result.creditedSeconds).toBe(50);
    expect(result.watchedSeconds).toBe(150);
  });

  it('leaves the ratio untouched when the duration is zero', () => {
    // A zero duration would make the ratio a division by zero; the stored
    // mark is the only honest answer.
    const result = applyPlaybackHeartbeat(
      state({ watchedSeconds: 100, maxWatchedRatio: 0.42 }),
      { positionSeconds: 130, now: at(20) },
      0,
    );

    expect(result.maxWatchedRatio).toBe(0.42);
    expect(Number.isNaN(result.maxWatchedRatio)).toBe(false);
  });
});
