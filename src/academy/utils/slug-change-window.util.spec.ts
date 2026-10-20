/**
 * The 60-day slug-change rule (owner decision, 20 Oct 2026) and the 409 the
 * API answers inside the window. End to end in
 * `test/academy-address-change.e2e-spec.ts`.
 */
import { nextSlugChangeAt, SLUG_CHANGE_INTERVAL_DAYS } from './slug-change-window.util';
import { slugChangeTooSoon } from '../services/academies.service';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-20T12:00:00.000Z');
const daysBefore = (days: number) => new Date(NOW.getTime() - days * DAY);

describe('nextSlugChangeAt', () => {
  it('allows the first change: creation does not start the clock', () => {
    expect(nextSlugChangeAt(null, NOW)).toBeNull();
    expect(nextSlugChangeAt(undefined, NOW)).toBeNull();
  });

  it('names the date 60 days after the last change while inside the window', () => {
    expect(SLUG_CHANGE_INTERVAL_DAYS).toBe(60);
    expect(nextSlugChangeAt(daysBefore(0), NOW)?.toISOString()).toBe(
      '2026-12-19T12:00:00.000Z',
    );
    expect(nextSlugChangeAt(daysBefore(59), NOW)?.toISOString()).toBe(
      new Date(NOW.getTime() + DAY).toISOString(),
    );
  });

  it('allows a change from exactly 60 days on', () => {
    expect(nextSlugChangeAt(daysBefore(60), NOW)).toBeNull();
    expect(nextSlugChangeAt(daysBefore(61), NOW)).toBeNull();
  });
});

describe('slugChangeTooSoon', () => {
  it('is a 409 on the slug field carrying the next possible date', () => {
    const error = slugChangeTooSoon(new Date('2026-12-19T12:00:00.000Z'));
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toEqual({
      messageKey: 'errors.academy.slugChangeTooSoon',
      violations: [{ field: 'slug', messageKey: 'errors.academy.slugChangeTooSoon' }],
      details: { nextSlugChangeAt: '2026-12-19T12:00:00.000Z', intervalDays: 60 },
    });
  });
});
