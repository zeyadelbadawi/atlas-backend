/**
 * Attendance arithmetic and policy.
 *
 * These are pure functions, and they are where attendance is most likely
 * to be quietly wrong: summing durations instead of unioning time ranges
 * produces 90 minutes of attendance in a 45-minute session and nobody
 * notices until a parent asks. The overlap cases below are the whole
 * reason the merge exists.
 */
import {
  DEFAULT_ATTENDANCE_POLICY,
  classifyAttendance,
  totalAttendedSeconds,
} from './attendance.service';

const at = (iso: string) => new Date(`2026-06-01T${iso}.000Z`);
const SESSION_END = at('10:00:00');

describe('totalAttendedSeconds', () => {
  it('sums separate intervals — the worked example from the brief', () => {
    // 09:01→09:03 (2m) + 09:07→09:09 (2m) + 09:12→09:17 (5m) = 9 minutes.
    const total = totalAttendedSeconds(
      [
        { joinedAt: at('09:01:00'), leftAt: at('09:03:00') },
        { joinedAt: at('09:07:00'), leftAt: at('09:09:00') },
        { joinedAt: at('09:12:00'), leftAt: at('09:17:00') },
      ],
      SESSION_END,
    );
    expect(total).toBe(9 * 60);
  });

  /*
   * THE ONE THAT MATTERS. A participant on a phone AND a laptop produces
   * two concurrent intervals. Presence is the union of the ranges, not the
   * sum of their lengths.
   */
  it('MERGES overlapping intervals rather than double-counting them', () => {
    const total = totalAttendedSeconds(
      [
        { joinedAt: at('09:00:00'), leftAt: at('09:30:00') },
        { joinedAt: at('09:10:00'), leftAt: at('09:20:00') },
      ],
      SESSION_END,
    );
    // 30 minutes of real presence, not 40.
    expect(total).toBe(30 * 60);
  });

  it('merges partially overlapping intervals into one span', () => {
    const total = totalAttendedSeconds(
      [
        { joinedAt: at('09:00:00'), leftAt: at('09:20:00') },
        { joinedAt: at('09:15:00'), leftAt: at('09:35:00') },
      ],
      SESSION_END,
    );
    expect(total).toBe(35 * 60);
  });

  it('handles intervals supplied out of order', () => {
    const total = totalAttendedSeconds(
      [
        { joinedAt: at('09:30:00'), leftAt: at('09:40:00') },
        { joinedAt: at('09:00:00'), leftAt: at('09:10:00') },
      ],
      SESSION_END,
    );
    expect(total).toBe(20 * 60);
  });

  it('measures a still-open interval to the session end, not to "now"', () => {
    // A finished session's numbers must stop moving.
    const total = totalAttendedSeconds(
      [{ joinedAt: at('09:30:00'), leftAt: null }],
      SESSION_END,
    );
    expect(total).toBe(30 * 60);
  });

  it('ignores zero-length and inverted intervals', () => {
    const total = totalAttendedSeconds(
      [
        { joinedAt: at('09:00:00'), leftAt: at('09:00:00') },
        { joinedAt: at('09:30:00'), leftAt: at('09:20:00') },
      ],
      SESSION_END,
    );
    expect(total).toBe(0);
  });

  it('returns zero for no intervals', () => {
    expect(totalAttendedSeconds([], SESSION_END)).toBe(0);
  });
});

describe('classifyAttendance', () => {
  const HOUR = 60 * 60;

  it('marks full presence as attended', () => {
    const { status, percent } = classifyAttendance(HOUR, HOUR);
    expect(status).toBe('attended');
    expect(percent).toBe(100);
  });

  it('marks no presence as absent', () => {
    expect(classifyAttendance(0, HOUR).status).toBe('absent');
  });

  it('requires BOTH the percentage and the absolute minimum', () => {
    // 80% of a 5-minute session is 4 minutes — over the percentage bar but
    // under the 5-minute floor, so not full attendance.
    const shortSession = 5 * 60;
    const { status } = classifyAttendance(4 * 60, shortSession);
    expect(status).toBe('partial');
  });

  it('marks a long-but-proportionally-small stay as partial', () => {
    // 10 minutes of a 2-hour session: clears the minute floor, fails the
    // percentage.
    const { status } = classifyAttendance(10 * 60, 2 * HOUR);
    expect(status).toBe('partial');
  });

  it('treats the policy boundary as inclusive', () => {
    const total = Math.round(HOUR * (DEFAULT_ATTENDANCE_POLICY.minimumPercent / 100));
    expect(classifyAttendance(total, HOUR).status).toBe('attended');
  });

  it('never reports more than 100 percent', () => {
    // A session that overran: presence legitimately exceeds the schedule.
    const { percent } = classifyAttendance(2 * HOUR, HOUR);
    expect(percent).toBe(100);
  });

  it('does not divide by zero when a session has no scheduled duration', () => {
    const { percent, status } = classifyAttendance(0, 0);
    expect(percent).toBe(0);
    expect(status).toBe('absent');
  });
});
