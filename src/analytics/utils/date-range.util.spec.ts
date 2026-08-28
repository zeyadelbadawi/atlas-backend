import {
  resolveDateRange,
  previousPeriod,
  enumerateDays,
  toIsoDate,
  currentCalendarMonth,
  previousCalendarMonth,
} from './date-range.util';
import { BadRequestException } from '@nestjs/common';

describe('resolveDateRange', () => {
  it('defaults to the last 30 days (inclusive) when both from/to are omitted', () => {
    const range = resolveDateRange(undefined, undefined);
    const days = enumerateDays(range);
    expect(days).toHaveLength(30);
    expect(toIsoDate(range.to)).toBe(toIsoDate(new Date()));
  });

  it('parses an explicit inclusive from/to range, end-of-day inclusive on `to`', () => {
    const range = resolveDateRange('2026-08-01', '2026-08-03');
    expect(toIsoDate(range.from)).toBe('2026-08-01');
    expect(toIsoDate(range.to)).toBe('2026-08-03');
    expect(range.to.getUTCHours()).toBe(23);
    expect(range.to.getUTCMinutes()).toBe(59);
    expect(enumerateDays(range)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
  });

  it('rejects a range where from is after to', () => {
    expect(() => resolveDateRange('2026-08-10', '2026-08-01')).toThrow(
      BadRequestException,
    );
  });

  it('rejects a malformed date string', () => {
    expect(() => resolveDateRange('not-a-date', '2026-08-01')).toThrow(
      BadRequestException,
    );
  });

  it('rejects when only one of from/to is supplied', () => {
    expect(() => resolveDateRange('2026-08-01', undefined)).toThrow(BadRequestException);
    expect(() => resolveDateRange(undefined, '2026-08-01')).toThrow(BadRequestException);
  });
});

describe('previousPeriod', () => {
  it('returns the immediately preceding period of equal length', () => {
    const range = resolveDateRange('2026-08-10', '2026-08-19'); // 10 days
    const previous = previousPeriod(range);
    expect(toIsoDate(previous.to)).toBe('2026-08-09');
    expect(toIsoDate(previous.from)).toBe('2026-07-31'); // also 10 days
    expect(enumerateDays(previous)).toHaveLength(10);
  });
});

describe('enumerateDays', () => {
  it('returns a single day for a same-day range', () => {
    const range = resolveDateRange('2026-08-05', '2026-08-05');
    expect(enumerateDays(range)).toEqual(['2026-08-05']);
  });
});

describe('currentCalendarMonth / previousCalendarMonth', () => {
  it('computes calendar month boundaries correctly across a year rollover', () => {
    const jan15 = new Date('2026-01-15T12:00:00.000Z');
    const current = currentCalendarMonth(jan15);
    expect(toIsoDate(current.from)).toBe('2026-01-01');
    expect(toIsoDate(current.to)).toBe('2026-01-31');

    const previous = previousCalendarMonth(current);
    expect(toIsoDate(previous.from)).toBe('2025-12-01');
    expect(toIsoDate(previous.to)).toBe('2025-12-31');
  });

  it('handles a 28-day February correctly', () => {
    const current = currentCalendarMonth(new Date('2026-03-10T00:00:00.000Z'));
    const previous = previousCalendarMonth(current);
    expect(toIsoDate(previous.from)).toBe('2026-02-01');
    expect(toIsoDate(previous.to)).toBe('2026-02-28');
  });
});
