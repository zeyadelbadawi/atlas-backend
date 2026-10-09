/**
 * class-validator rules for a `phoneNumber` + `phoneCountry` pair, built on
 * `normalizePhoneNumber` so a DTO and the service can never disagree.
 *
 * One constraint per rejection reason, so each reaches the client as its own
 * `validation:*` key on the `phoneNumber` field (see
 * `class-validator-violations.util.ts`): "not a valid number", "belongs to
 * another country", "not a mobile number". Each rule passes when a DIFFERENT
 * reason applies, so one bad number yields exactly one violation. An invalid
 * country is reported on `phoneCountry` only.
 *
 * Validation happens in the DTO — before any service code runs or any row is
 * read — so the answer is the same for every caller and says nothing about
 * other accounts.
 */
import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { normalizePhoneCountry, normalizePhoneNumber } from './phone-number.policy';
import type { PhoneRejection } from './phone-number.policy';

/** Constraint names, mapped to message keys in `class-validator-violations.util.ts`. */
export const PHONE_CONSTRAINTS = {
  invalidNumber: 'isPhoneNumber',
  countryMismatch: 'isPhoneNumberInCountry',
  notMobile: 'isMobilePhoneNumber',
  invalidCountry: 'isPhoneCountry',
} as const;

function phoneNumberRule(
  name: string,
  rejection: PhoneRejection,
  countryProperty: string,
  message: string,
  options?: ValidationOptions,
) {
  return (target: object, propertyName: string): void => {
    registerDecorator({
      name,
      target: target.constructor,
      propertyName,
      constraints: [countryProperty],
      options: { message, ...options },
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const country = (args.object as Record<string, unknown>)[countryProperty];
          const result = normalizePhoneNumber(value, country);
          if (result.ok) return true;
          // An unusable country is the country field's violation, not this one.
          if (result.reason === 'invalid_country') return true;
          return result.reason !== rejection;
        },
      },
    });
  };
}

/** `phoneNumber` must be a valid number (reported as `validation:invalidPhone`). */
export function IsPhoneNumberFor(countryProperty: string, options?: ValidationOptions) {
  return phoneNumberRule(
    PHONE_CONSTRAINTS.invalidNumber,
    'invalid_number',
    countryProperty,
    'phone number is not valid',
    options,
  );
}

/** `phoneNumber` must belong to the chosen country (`validation:phoneCountryMismatch`). */
export function IsPhoneNumberInCountry(
  countryProperty: string,
  options?: ValidationOptions,
) {
  return phoneNumberRule(
    PHONE_CONSTRAINTS.countryMismatch,
    'country_mismatch',
    countryProperty,
    'phone number belongs to another country',
    options,
  );
}

/** `phoneNumber` must be able to receive SMS/WhatsApp (`validation:phoneNotMobile`). */
export function IsMobilePhoneNumber(
  countryProperty: string,
  options?: ValidationOptions,
) {
  return phoneNumberRule(
    PHONE_CONSTRAINTS.notMobile,
    'not_mobile',
    countryProperty,
    'phone number is not a mobile number',
    options,
  );
}

/** `phoneCountry` must be a supported ISO 3166-1 alpha-2 code (`validation:invalidPhoneCountry`). */
export function IsPhoneCountry(options?: ValidationOptions) {
  return (target: object, propertyName: string): void => {
    registerDecorator({
      name: PHONE_CONSTRAINTS.invalidCountry,
      target: target.constructor,
      propertyName,
      options: { message: 'phone country is not supported', ...options },
      validator: {
        validate: (value: unknown) => normalizePhoneCountry(value) !== null,
      },
    });
  };
}

/** True when the request carries any part of a phone number (both fields are then required). */
export function hasPhoneInput(object: {
  readonly phoneNumber?: unknown;
  readonly phoneCountry?: unknown;
}): boolean {
  return object.phoneNumber !== undefined || object.phoneCountry !== undefined;
}
