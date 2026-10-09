/**
 * Forensic watermark codes (docs/FORENSIC_WATERMARK.md).
 *
 * SHAPE. Ten symbols of Crockford base32 — nine random, then one Crockford
 * mod-37 check symbol — displayed as two groups of five: `7K3QM-X9TR7`.
 * Crockford's alphabet was chosen because a code is read back by a PERSON
 * off a compressed, re-encoded screen recording: it has no I, L, O or U, so
 * the classic OCR confusions (O/0, I/1/L) have only one possible reading.
 *
 * THE CHECK SYMBOL IS ALWAYS ALPHANUMERIC. Standard Crockford mod-37 uses
 * five extra symbols (`* ~ $ = U`) for check values 32–36. Those are hard to
 * read in a video and easy to mistake for noise, so a code whose check value
 * would need one is simply never issued (rejection sampling: ~13.5% of draws
 * are discarded). Every code is therefore still a valid Crockford mod-37
 * string, its check symbol is always from the ordinary 32-symbol alphabet,
 * and a single misread symbol — or two adjacent symbols swapped — is caught
 * by the check before any lookup runs.
 *
 * ENTROPY. 9 × 5 = 45 bits before rejection (~3.0e13 usable codes). The
 * column is UNIQUE and the issuer redraws on the (vanishingly rare)
 * collision, so uniqueness never rests on probability alone.
 */
import { randomInt } from 'node:crypto';

export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** The full mod-37 check alphabet; values 32–36 are never issued (see above). */
const CHECK_ALPHABET = `${CROCKFORD_ALPHABET}*~$=U`;
export const WATERMARK_CODE_DATA_LENGTH = 9;
export const WATERMARK_CODE_LENGTH = WATERMARK_CODE_DATA_LENGTH + 1;

const VALUE_OF = new Map<string, number>(
  [...CROCKFORD_ALPHABET].map((symbol, index) => [symbol, index]),
);

/** Crockford mod-37 of a base32 data string (no check symbol). */
export function crockfordCheckValue(data: string): number {
  let remainder = 0;
  for (const symbol of data) {
    const value = VALUE_OF.get(symbol);
    if (value === undefined) throw new Error('Not a Crockford base32 symbol.');
    remainder = (remainder * 32 + value) % 37;
  }
  return remainder;
}

export function crockfordCheckSymbol(data: string): string {
  return CHECK_ALPHABET[crockfordCheckValue(data)];
}

/**
 * Draws a new code (normalised form, no dash). `random` is injectable only
 * so the rejection loop can be tested deterministically.
 */
export function generateWatermarkCode(
  random: (maxExclusive: number) => number = randomInt,
): string {
  for (;;) {
    let data = '';
    for (let i = 0; i < WATERMARK_CODE_DATA_LENGTH; i += 1) {
      data += CROCKFORD_ALPHABET[random(32)];
    }
    const check = crockfordCheckValue(data);
    if (check < 32) return data + CROCKFORD_ALPHABET[check];
  }
}

/** `7K3QMX9TR7` → `7K3QM-X9TR7`. */
export function formatWatermarkCode(code: string): string {
  return code.length === WATERMARK_CODE_LENGTH
    ? `${code.slice(0, 5)}-${code.slice(5)}`
    : code;
}

const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const EXTENDED_ARABIC_INDIC_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

export type WatermarkCodeProblem = 'empty' | 'length' | 'symbol' | 'checksum';

export type NormalizedWatermarkCode =
  | { readonly ok: true; readonly code: string; readonly display: string }
  | {
      readonly ok: false;
      readonly problem: WatermarkCodeProblem;
      /** The input after normalisation, for "did you mean" feedback. */
      readonly normalized: string;
    };

/**
 * Turns whatever a person typed or pasted from a recording into a code.
 *
 * Case-insensitive; spaces, dashes, dots, underscores and slashes are
 * dropped; Crockford's own aliases are applied (O→0, I/L→1); Arabic-Indic
 * digits are read as Latin digits, because an operator with an Arabic
 * keyboard layout types them. The check symbol is verified, so a misread is
 * reported as a misread rather than as "not found".
 */
export function normalizeWatermarkCode(input: string): NormalizedWatermarkCode {
  const normalized = [...(input ?? '').normalize('NFKC').toUpperCase()]
    .map((symbol) => {
      const arabic = ARABIC_INDIC_DIGITS.indexOf(symbol);
      if (arabic >= 0) return String(arabic);
      const extended = EXTENDED_ARABIC_INDIC_DIGITS.indexOf(symbol);
      if (extended >= 0) return String(extended);
      if (symbol === 'O') return '0';
      if (symbol === 'I' || symbol === 'L') return '1';
      return symbol;
    })
    .filter((symbol) => !/[\s\-–—._/\\·•]/.test(symbol))
    .join('');

  if (normalized.length === 0) return { ok: false, problem: 'empty', normalized };
  if (normalized.length !== WATERMARK_CODE_LENGTH) {
    return { ok: false, problem: 'length', normalized };
  }
  if (![...normalized].every((symbol) => VALUE_OF.has(symbol))) {
    return { ok: false, problem: 'symbol', normalized };
  }
  const data = normalized.slice(0, WATERMARK_CODE_DATA_LENGTH);
  if (crockfordCheckSymbol(data) !== normalized[WATERMARK_CODE_DATA_LENGTH]) {
    return { ok: false, problem: 'checksum', normalized };
  }
  return { ok: true, code: normalized, display: formatWatermarkCode(normalized) };
}
