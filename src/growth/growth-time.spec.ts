/**
 * G1 — Cairo calendar arithmetic: months and Saturday–Friday weeks on the
 * Cairo calendar, across Egypt's DST transitions (UTC+3 from the last
 * Friday of April to the last Thursday of October since 2023) and in the
 * DST-free years (2015–2022, UTC+2 all year).
 */
import {
  addDays,
  addMonths,
  cairoDate,
  cairoMonth,
  cairoOffsetMs,
  cairoStartOfDay,
  cairoStartOfMonth,
  daysBetween,
  monthCount,
  monthRange,
  weekStartSaturday,
} from './growth-time';

const HOUR = 3_600_000;

describe('Cairo offsets', () => {
  it('UTC+2 all year in a DST-free year (2022)', () => {
    expect(cairoOffsetMs(new Date('2022-01-15T12:00:00Z'))).toBe(2 * HOUR);
    expect(cairoOffsetMs(new Date('2022-07-15T12:00:00Z'))).toBe(2 * HOUR);
  });

  it('UTC+3 in summer and UTC+2 in winter since 2023', () => {
    expect(cairoOffsetMs(new Date('2026-07-15T12:00:00Z'))).toBe(3 * HOUR);
    expect(cairoOffsetMs(new Date('2026-12-15T12:00:00Z'))).toBe(2 * HOUR);
  });
});

describe('cairoDate / cairoMonth', () => {
  it('a signup at 23:30 Cairo on 31 March is a March signup (UTC+2)', () => {
    // 2026-03-31 23:30 EET = 21:30 UTC.
    expect(cairoDate(new Date('2026-03-31T21:30:00Z'))).toBe('2026-03-31');
    expect(cairoMonth(new Date('2026-03-31T21:30:00Z'))).toBe('2026-03');
    // 22:30 UTC is already 1 April 00:30 in Cairo.
    expect(cairoMonth(new Date('2026-03-31T22:30:00Z'))).toBe('2026-04');
  });

  it('the month turns at 21:00 UTC in summer (UTC+3)', () => {
    expect(cairoMonth(new Date('2026-06-30T20:59:59Z'))).toBe('2026-06');
    expect(cairoMonth(new Date('2026-06-30T21:00:00Z'))).toBe('2026-07');
  });

  it('the month turns at 22:00 UTC in a DST-free year', () => {
    expect(cairoMonth(new Date('2022-06-30T21:59:59Z'))).toBe('2022-06');
    expect(cairoMonth(new Date('2022-06-30T22:00:00Z'))).toBe('2022-07');
  });
});

describe('cairoStartOfDay', () => {
  it('local midnight as an instant, winter and summer', () => {
    expect(cairoStartOfDay('2026-01-10').toISOString()).toBe('2026-01-09T22:00:00.000Z');
    expect(cairoStartOfDay('2026-07-11').toISOString()).toBe('2026-07-10T21:00:00.000Z');
    expect(cairoStartOfDay('2022-07-09').toISOString()).toBe('2022-07-08T22:00:00.000Z');
  });

  it('spring forward (Friday 26 April 2024): 00:00 does not exist, the day starts at 01:00', () => {
    const start = cairoStartOfDay('2024-04-26');
    expect(start.toISOString()).toBe('2024-04-25T22:00:00.000Z');
    expect(cairoDate(start)).toBe('2024-04-26');
    expect(cairoDate(new Date(start.getTime() - 1))).toBe('2024-04-25');
  });

  it('fall back (Thursday 29 → Friday 30 October 2026): Friday starts once, at 22:00 UTC', () => {
    const start = cairoStartOfDay('2026-10-30');
    expect(start.toISOString()).toBe('2026-10-29T22:00:00.000Z');
    expect(cairoDate(new Date(start.getTime() - 1))).toBe('2026-10-29');
    // Thursday 29 October still started at UTC+3.
    expect(cairoStartOfDay('2026-10-29').toISOString()).toBe('2026-10-28T21:00:00.000Z');
  });

  it('month starts', () => {
    expect(cairoStartOfMonth('2026-11').toISOString()).toBe('2026-10-31T22:00:00.000Z');
    expect(cairoStartOfMonth('2026-10').toISOString()).toBe('2026-09-30T21:00:00.000Z');
  });
});

describe('weeks: Saturday to Friday', () => {
  it.each([
    ['2026-10-24', '2026-10-24'], // Saturday
    ['2026-10-25', '2026-10-24'], // Sunday
    ['2026-10-26', '2026-10-24'], // Monday
    ['2026-10-30', '2026-10-24'], // Friday
    ['2026-10-31', '2026-10-31'], // next Saturday
    ['2027-01-01', '2026-12-26'], // across a year end
  ])('%s is in the week starting %s', (date, start) => {
    expect(weekStartSaturday(date)).toBe(start);
  });

  it('Friday 23:59 Cairo belongs to the ending week; Saturday 00:00 to the next (summer)', () => {
    // Friday 2026-07-17 23:59 EEST = 20:59 UTC; Saturday 00:00 = 21:00 UTC.
    expect(weekStartSaturday(cairoDate(new Date('2026-07-17T20:59:00Z')))).toBe(
      '2026-07-11',
    );
    expect(weekStartSaturday(cairoDate(new Date('2026-07-17T21:00:00Z')))).toBe(
      '2026-07-18',
    );
  });

  it('the same boundary in winter and in a DST-free year sits at 22:00 UTC', () => {
    expect(weekStartSaturday(cairoDate(new Date('2026-12-18T21:59:00Z')))).toBe(
      '2026-12-12',
    );
    expect(weekStartSaturday(cairoDate(new Date('2026-12-18T22:00:00Z')))).toBe(
      '2026-12-19',
    );
    expect(weekStartSaturday(cairoDate(new Date('2022-07-15T21:59:00Z')))).toBe(
      '2022-07-09',
    );
    expect(weekStartSaturday(cairoDate(new Date('2022-07-15T22:00:00Z')))).toBe(
      '2022-07-16',
    );
  });

  it('the week holding the fall-back night (Sat 24 – Fri 30 Oct 2026) is one week', () => {
    // Thursday 23:30 EEST (before the clocks go back) and 23:30 EET (after).
    expect(weekStartSaturday(cairoDate(new Date('2026-10-29T20:30:00Z')))).toBe(
      '2026-10-24',
    );
    expect(weekStartSaturday(cairoDate(new Date('2026-10-29T21:30:00Z')))).toBe(
      '2026-10-24',
    );
    // Friday 23:59 EET is still that week; Saturday 00:00 EET the next.
    expect(weekStartSaturday(cairoDate(new Date('2026-10-30T21:59:00Z')))).toBe(
      '2026-10-24',
    );
    expect(weekStartSaturday(cairoDate(new Date('2026-10-30T22:00:00Z')))).toBe(
      '2026-10-31',
    );
  });

  it('the week holding the spring-forward night (Sat 20 – Fri 26 Apr 2024)', () => {
    expect(weekStartSaturday(cairoDate(new Date('2024-04-25T21:59:00Z')))).toBe(
      '2024-04-20',
    );
    expect(weekStartSaturday(cairoDate(new Date('2024-04-25T22:00:00Z')))).toBe(
      '2024-04-20',
    );
    // Friday 26 April 23:59 EEST = 20:59 UTC; Saturday 00:00 EEST = 21:00 UTC.
    expect(weekStartSaturday(cairoDate(new Date('2024-04-26T20:59:00Z')))).toBe(
      '2024-04-20',
    );
    expect(weekStartSaturday(cairoDate(new Date('2024-04-26T21:00:00Z')))).toBe(
      '2024-04-27',
    );
  });
});

describe('calendar arithmetic', () => {
  it('days', () => {
    expect(addDays('2026-10-26', 6)).toBe('2026-11-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(daysBetween('2026-10-26', '2027-06-01')).toBe(218);
    expect(daysBetween('2027-06-01', '2026-10-26')).toBe(-218);
  });

  it('months', () => {
    expect(addMonths('2026-11', 2)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(monthCount('2026-05', '2026-10')).toBe(6);
    expect(monthCount('2026-10', '2026-05')).toBe(-4);
    expect(monthRange('2026-11', '2027-02')).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
    ]);
  });
});
