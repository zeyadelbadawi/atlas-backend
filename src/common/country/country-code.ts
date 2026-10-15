/**
 * D5-3 — an academy's country (`academies.address.country`) is an ISO
 * 3166-1 alpha-2 code, upper case (`EG`), never a display name. The known
 * codes are libphonenumber's, the same list the phone field's country
 * selector offers on both sides (`identity/phone/phone-number.policy.ts`).
 *
 * As with the currency allow-list, a value stored before this rule stays
 * valid when re-sent unchanged (the profile form re-sends the whole
 * address), and an empty string clears the country.
 */
import { BadRequestException } from '@nestjs/common';
import { isSupportedCountry } from 'libphonenumber-js/max';

export function isCountryCode(value: string): boolean {
  return /^[A-Z]{2}$/.test(value) && isSupportedCountry(value);
}

/** The same 400 a DTO violation produces, on `field`. */
export function invalidCountryError(field: string): BadRequestException {
  return new BadRequestException({
    messageKey: 'errors.validation.failed',
    violations: [{ field, messageKey: 'validation:invalidCountry' }],
  });
}

/**
 * Throws unless `next` is absent, empty, unchanged from `current`, or a
 * known upper-case alpha-2 code.
 */
export function assertCountryAllowed(
  next: string | null | undefined,
  current: string | null | undefined,
  field: string,
): void {
  if (next === undefined || next === null || next === '') return;
  if (current !== undefined && current !== null && next === current) return;
  if (!isCountryCode(next)) throw invalidCountryError(field);
}
