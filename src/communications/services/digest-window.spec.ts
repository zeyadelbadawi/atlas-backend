/**
 * `nextLocalHour` decides `communication_digests.window_start`, which is
 * two thirds of that table's `(recipient_user_id, kind, window_start)`
 * unique index. The index is the only thing that makes "one digest per
 * recipient per window" a database fact, so the boundary must be a
 * function of the DAY and the ZONE alone — never of the instant that
 * happened to ask.
 */
import { digestKind, nextLocalHour } from './communication-dispatch.service';

const HOUR = 8;

describe('nextLocalHour', () => {
  it('lands exactly on the hour, with no seconds or milliseconds', () => {
    const boundary = nextLocalHour(new Date('2026-09-25T00:52:41.575Z'), 'UTC', HOUR);
    expect(boundary.toISOString()).toBe('2026-09-25T08:00:00.000Z');
  });

  it('is identical for two instants a millisecond apart', () => {
    // The race the unique index exists to lose gracefully: two workers
    // opening the same window must compute the same `window_start`, or
    // they collide on nothing and the recipient gets two digests.
    const a = nextLocalHour(new Date('2026-09-25T00:52:41.001Z'), 'UTC', HOUR);
    const b = nextLocalHour(new Date('2026-09-25T00:52:41.999Z'), 'UTC', HOUR);
    expect(a.getTime()).toBe(b.getTime());
    expect(a.getMilliseconds()).toBe(0);
    expect(a.getSeconds()).toBe(0);
  });

  it('is identical for every instant within the same window', () => {
    const boundaries = new Set(
      [
        '2026-09-25T00:00:00.000Z',
        '2026-09-25T03:17:09.123Z',
        '2026-09-25T07:59:59.999Z',
      ].map((iso) => nextLocalHour(new Date(iso), 'UTC', HOUR).getTime()),
    );
    expect(boundaries.size).toBe(1);
  });

  it('is strictly after `now`, so a boundary instant rolls to the next day', () => {
    const onTheBoundary = new Date('2026-09-25T08:00:00.000Z');
    const next = nextLocalHour(onTheBoundary, 'UTC', HOUR);
    expect(next.getTime()).toBeGreaterThan(onTheBoundary.getTime());
    expect(next.toISOString()).toBe('2026-09-26T08:00:00.000Z');
  });

  it('resolves the hour in the ACADEMY’s zone, not the server’s', () => {
    // 08:00 in Dubai (UTC+4) is 04:00Z; the same instant in UTC is 08:00Z.
    const now = new Date('2026-09-25T00:52:41.575Z');
    expect(nextLocalHour(now, 'Asia/Dubai', HOUR).toISOString()).toBe(
      '2026-09-25T04:00:00.000Z',
    );
    expect(nextLocalHour(now, 'UTC', HOUR).toISOString()).toBe(
      '2026-09-25T08:00:00.000Z',
    );
  });

  it('falls back to UTC for a zone Postgres let through but Intl does not know', () => {
    expect(
      nextLocalHour(
        new Date('2026-09-25T00:52:41.575Z'),
        'Mars/Olympus',
        HOUR,
      ).toISOString(),
    ).toBe('2026-09-25T08:00:00.000Z');
  });
});

describe('digestKind', () => {
  it('keeps the three audiences in separate windows', () => {
    expect(
      new Set(['learner', 'staff', 'platform'].map((a) => digestKind(a as never))).size,
    ).toBe(3);
  });
});
