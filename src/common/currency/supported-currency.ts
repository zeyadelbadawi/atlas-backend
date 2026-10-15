/**
 * B0-LRN-05 / B0-COM-05 — the currencies an academy or a course price may
 * be set in. EGP only for now (Atlas sells in Egypt first); extend this one
 * list to open another currency.
 *
 * A value already stored stays valid: an academy or course saved earlier in
 * another currency can still be saved with that same value (the settings
 * forms re-send it), it just cannot be switched to a new unsupported one.
 * Plan prices are a separate, Platform-Owner-set field and are not covered.
 *
 * D5-3 — the academy currency is the DEFAULT for a new course price
 * (`defaultPriceCurrency`). Only a default: a price keeps the currency it was
 * saved with, changing the academy currency never rewrites one, and nothing
 * is ever converted.
 */
import { BadRequestException } from '@nestjs/common';

export const SUPPORTED_CURRENCIES: readonly string[] = ['EGP'];

export const DEFAULT_CURRENCY = 'EGP';

/**
 * The currency a course price gets when the request names none: the
 * academy's own, unless that is a legacy value no new price may use, in
 * which case the platform default.
 */
export function defaultPriceCurrency(academyCurrency: string | null | undefined): string {
  return academyCurrency && SUPPORTED_CURRENCIES.includes(academyCurrency)
    ? academyCurrency
    : DEFAULT_CURRENCY;
}

/** The same 400 a DTO violation produces, on `field`. */
export function unsupportedCurrencyError(field: string): BadRequestException {
  return new BadRequestException({
    messageKey: 'errors.validation.failed',
    violations: [{ field, messageKey: 'validation:unsupportedCurrency' }],
  });
}

/**
 * Throws unless `next` is absent, unchanged from `current`, or supported.
 */
export function assertCurrencyAllowed(
  next: string | null | undefined,
  current: string | null | undefined,
  field: string,
): void {
  if (next === undefined || next === null) return;
  if (current !== undefined && current !== null && next === current) return;
  if (!SUPPORTED_CURRENCIES.includes(next)) throw unsupportedCurrencyError(field);
}
