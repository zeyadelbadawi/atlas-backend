/**
 * Phone numbers — the ONE server-side rule for what Atlas accepts and how it
 * is stored. Every write path (registration, profile) goes through
 * `normalizePhoneNumber`; the client's own formatting or normalisation is
 * never trusted — only the raw text the person typed and the country they
 * picked are read.
 *
 * POLICY (docs/USER_PHONE.md):
 *   - The country is an ISO 3166-1 alpha-2 code libphonenumber knows.
 *   - The text is at most `PHONE_INPUT_MAX_LENGTH` characters of digits
 *     (ASCII, Arabic-Indic or Extended Arabic-Indic — people in Arabic
 *     locales type those), spaces, `+ - ( ) .` and nothing else. libphonenumber
 *     on its own would happily extract a number from "call me on 0100…" or
 *     drop an "ext 5"; that is garbage and is refused here instead.
 *   - The number must be VALID (libphonenumber "max" metadata) and must
 *     belong to the chosen country — a Canadian number under "United States"
 *     is refused rather than silently re-labelled, so what is stored is what
 *     the person confirmed.
 *   - MOBILE ONLY: the number type must be `MOBILE` or `FIXED_LINE_OR_MOBILE`
 *     (the latter is how libphonenumber reports regions such as the US/Canada
 *     whose numbering plan does not distinguish the two). The number exists
 *     to reach the person — and, once a provider is contracted, to verify it
 *     by SMS or WhatsApp — and a landline, toll-free, premium-rate, shared-
 *     cost, VoIP, pager or UAN number can receive neither.
 *
 * Stored as E.164 (`+201001234567`) plus the chosen country.
 */
import {
  getCountryCallingCode,
  isSupportedCountry,
  parsePhoneNumberWithError,
  type CountryCode,
} from 'libphonenumber-js/max';

/** Generous for any formatted national or international number, small enough to refuse an essay. */
export const PHONE_INPUT_MAX_LENGTH = 32;

/** The number types accepted (see the policy above). */
const ACCEPTED_TYPES = new Set(['MOBILE', 'FIXED_LINE_OR_MOBILE']);

/** Digits, separators and a leading `+` only; at least four digits are checked after normalising. */
const ALLOWED_CHARACTERS = /^\+?[0-9\s\-().]+$/;

export type PhoneRejection =
  /** Not a supported ISO 3166-1 alpha-2 country. */
  | 'invalid_country'
  /** Too long, illegal characters, or not a valid number. */
  | 'invalid_number'
  /** A valid number, but of another country than the one chosen. */
  | 'country_mismatch'
  /** A valid number that cannot receive SMS/WhatsApp (landline, toll-free, …). */
  | 'not_mobile';

export interface NormalizedPhoneNumber {
  /** `+201001234567` */
  readonly e164: string;
  /** `EG` */
  readonly country: string;
  /** `20` */
  readonly callingCode: string;
  /** `1001234567` — national significant number, no trunk prefix. */
  readonly nationalNumber: string;
}

export type PhoneNormalizationResult =
  | { readonly ok: true; readonly phone: NormalizedPhoneNumber }
  | { readonly ok: false; readonly reason: PhoneRejection };

/** Arabic-Indic (U+0660–0669) and Extended Arabic-Indic (U+06F0–06F9) digits → ASCII. */
export function toAsciiDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/** Upper-cases and checks an ISO alpha-2 country against libphonenumber's metadata. */
export function normalizePhoneCountry(value: unknown): CountryCode | null {
  if (typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value)) return null;
  const upper = value.toUpperCase();
  return isSupportedCountry(upper) ? (upper as CountryCode) : null;
}

export function normalizePhoneNumber(
  rawNumber: unknown,
  rawCountry: unknown,
): PhoneNormalizationResult {
  const country = normalizePhoneCountry(rawCountry);
  if (!country) return { ok: false, reason: 'invalid_country' };
  if (typeof rawNumber !== 'string' || rawNumber.length > PHONE_INPUT_MAX_LENGTH) {
    return { ok: false, reason: 'invalid_number' };
  }
  const text = toAsciiDigits(rawNumber).trim();
  if (!ALLOWED_CHARACTERS.test(text) || text.replace(/\D/g, '').length < 4) {
    return { ok: false, reason: 'invalid_number' };
  }

  let parsed;
  try {
    parsed = parsePhoneNumberWithError(text, { defaultCountry: country });
  } catch {
    return { ok: false, reason: 'invalid_number' };
  }
  if (!parsed.isValid()) return { ok: false, reason: 'invalid_number' };
  if (parsed.country !== country) return { ok: false, reason: 'country_mismatch' };
  const type = parsed.getType();
  if (!type || !ACCEPTED_TYPES.has(type)) return { ok: false, reason: 'not_mobile' };

  return {
    ok: true,
    phone: {
      e164: parsed.number,
      country,
      callingCode: getCountryCallingCode(country),
      nationalNumber: parsed.nationalNumber,
    },
  };
}
