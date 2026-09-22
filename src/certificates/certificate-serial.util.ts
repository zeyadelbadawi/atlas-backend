/**
 * P64 Phase 3 (D6) — certificate identifiers.
 *
 * Serial: `WDA-2026-000123` — an academy prefix (initials of the academy
 * name, 2–4 letters), the issue year and a per-academy per-year counter
 * allocated atomically by `next_certificate_serial`. Human-readable and
 * unique per academy (database constraint).
 *
 * Verification code: 12 characters from the Crockford-style base32
 * alphabet without the ambiguous letters (I, L, O, U) — 60 bits of
 * randomness from `crypto`, so codes are not guessable and enumeration is
 * hopeless even before the rate limit. Stored upper-case; compared after
 * stripping separators so `ABCD-EFGH-JKLM` and `abcdefghjklm` both verify.
 */
import { randomBytes } from 'node:crypto';

export const VERIFICATION_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const VERIFICATION_CODE_LENGTH = 12;

export function generateVerificationCode(): string {
  const bytes = randomBytes(VERIFICATION_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < VERIFICATION_CODE_LENGTH; i += 1) {
    code += VERIFICATION_ALPHABET[bytes[i] % VERIFICATION_ALPHABET.length];
  }
  return code;
}

export function normalizeVerificationCode(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

export function isPlausibleVerificationCode(raw: string): boolean {
  const normalized = normalizeVerificationCode(raw);
  return (
    normalized.length === VERIFICATION_CODE_LENGTH &&
    [...normalized].every((ch) => VERIFICATION_ALPHABET.includes(ch))
  );
}

/** `ABCDEFGHJKLM` → `ABCD-EFGH-JKLM` for display. */
export function formatVerificationCode(code: string): string {
  const normalized = normalizeVerificationCode(code);
  return normalized.match(/.{1,4}/g)?.join('-') ?? normalized;
}

export function academySerialPrefix(academyName: string, slug: string): string {
  const words = academyName
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((word) => word.length > 0);
  let prefix = words
    .map((word) => word[0])
    .join('')
    .toUpperCase()
    .slice(0, 4);
  if (prefix.length < 2) {
    prefix = slug
      .replace(/[^A-Za-z0-9]/g, '')
      .toUpperCase()
      .slice(0, 3);
  }
  if (prefix.length < 2) prefix = 'AT';
  return prefix;
}

export function formatSerial(prefix: string, year: number, value: number): string {
  return `${prefix}-${year}-${String(value).padStart(6, '0')}`;
}
