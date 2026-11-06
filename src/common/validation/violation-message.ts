/**
 * B8 (UX audit) — DTO decorators that name their own field violation.
 *
 * `withViolation(key, values)` is a `ValidationOptions` object: the key is
 * the constraint's `message` (what Nest's default pipe would print) AND its
 * `context`, which `classValidatorErrorsToViolations` forwards as the
 * violation's `messageKey`/`values`. Use it where the generic
 * `validation:*` key for the constraint would not tell the person how to
 * fix the value — a format the field expects, or a range with both ends.
 */
import { applyDecorators } from '@nestjs/common';
import { IsInt, Max, Min, type ValidationOptions } from 'class-validator';

export type ViolationValues = Readonly<Record<string, string | number>>;

export function withViolation(
  messageKey: string,
  values?: ViolationValues,
): ValidationOptions {
  return { message: messageKey, context: { messageKey, ...(values ? { values } : {}) } };
}

/** The generic "whole number from {{min}} to {{max}}" key. */
export const INTEGER_RANGE_MESSAGE_KEY = 'validation:integerRange';

/**
 * A whole number from `min` to `max`, inclusive. Whatever is wrong — not a
 * number, a fraction, too small, too large — the field gets ONE violation
 * naming both ends: `messageKey` (default `validation:integerRange`) with
 * `values` (default `{ min, max }`).
 */
export function IsIntInRange(
  min: number,
  max: number,
  messageKey: string = INTEGER_RANGE_MESSAGE_KEY,
  values: ViolationValues = { min, max },
): PropertyDecorator {
  const options = withViolation(messageKey, values);
  return applyDecorators(IsInt(options), Min(min, options), Max(max, options));
}
