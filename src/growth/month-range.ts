/**
 * G1 — the `from` / `to` month window of the spend list and the CAC report.
 * Both optional: a missing `to` is the current Cairo month, a missing
 * `from` is `defaultMonths` back from `to` (both included). `from` after
 * `to` → 400 `errors.growth.monthRangeInvalid`; more than 36 months → 400
 * `errors.growth.monthRangeTooLong`.
 */
import { BadRequestException } from '@nestjs/common';
import { GROWTH_ERRORS } from './growth.constants';
import { GROWTH_LIMITS, MONTH_PATTERN } from './dto/growth.dto';
import { addMonths, cairoMonth, monthCount } from './growth-time';

export interface MonthRange {
  readonly from: string;
  readonly to: string;
}

export function resolveMonthRange(
  query: { readonly from?: string; readonly to?: string },
  now: Date,
  defaultMonths: number,
): MonthRange {
  for (const value of [query.from, query.to]) {
    if (value !== undefined && !MONTH_PATTERN.test(value)) {
      throw new BadRequestException({ messageKey: GROWTH_ERRORS.monthRangeInvalid });
    }
  }
  const to =
    query.to ?? (query.from ? maxMonth(query.from, cairoMonth(now)) : cairoMonth(now));
  const from = query.from ?? addMonths(to, -(defaultMonths - 1));
  const count = monthCount(from, to);
  if (count < 1) {
    throw new BadRequestException({ messageKey: GROWTH_ERRORS.monthRangeInvalid });
  }
  if (count > GROWTH_LIMITS.rangeMonths.max) {
    throw new BadRequestException({
      messageKey: GROWTH_ERRORS.monthRangeTooLong,
      details: { maxMonths: GROWTH_LIMITS.rangeMonths.max },
    });
  }
  return { from, to };
}

/** With only `from` given, `to` is the current month (or `from` itself when that is later). */
function maxMonth(a: string, b: string): string {
  return monthCount(a, b) >= 1 ? b : a;
}
