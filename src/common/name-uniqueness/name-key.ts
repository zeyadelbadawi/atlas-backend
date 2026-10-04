/**
 * W4 — TypeScript mirror of the SQL `atlas_name_key(text)` function
 * (prisma/migrations/20261104000300_w4_name_key_foundation). FOR FORM
 * MESSAGES AND PRE-VALIDATION ONLY: the database function is authoritative,
 * and every uniqueness decision is made by it (generated columns, unique
 * indexes, the SECURITY DEFINER checks). `name-key.spec.ts` and the e2e
 * parity test keep the two in step on the shared corpus.
 *
 * Steps, in the SQL order:
 *   1. NFKD
 *   2. strip Latin combining marks, Arabic harakat/hamza marks, superscript
 *      alef, Quranic marks, tatweel, zero-width/bidi controls and the BOM
 *   3. Unicode default lowercase (ICU root in SQL; `toLowerCase` here — both
 *      apply the same full case mapping, including final-sigma context)
 *   4. ς → σ
 *   5. NFKC
 *   6. collapse whitespace runs (ICU `u_isspace`, which the SQL regex uses
 *      because the ICU collation propagates to it) to one space; trim spaces
 *
 * Deliberately not folded: ى/ي, ة/ه, Arabic-Indic digits, punctuation.
 */

const STRIPPED =
  /[\u0300-\u036F\u064B-\u065F\u0670\u06D6-\u06ED\u0640\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

/** ICU `u_isspace`: TAB..CR, FS..US, NEL and the Zs/Zl/Zp categories. */
// eslint-disable-next-line no-control-regex -- FS..US are whitespace to ICU, so to the SQL key.
const WHITESPACE_RUN = /[\t\n\v\f\r\u001C-\u001F\u0085\p{Zs}\p{Zl}\p{Zp}]+/gu;

export function normalizeNameKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(STRIPPED, '')
    .toLowerCase()
    .replace(/ς/g, 'σ')
    .normalize('NFKC')
    .replace(WHITESPACE_RUN, ' ')
    .replace(/^ +| +$/g, '');
}

/** True when a name reduces to nothing comparable (only marks/invisibles/space). */
export function isEmptyNameKey(value: string): boolean {
  return normalizeNameKey(value) === '';
}

/**
 * The display value stored for an organization or academy name: trimmed, with
 * inner whitespace runs collapsed to one space (what the key ignores anyway).
 */
export function cleanDisplayName(value: string): string {
  return value.replace(WHITESPACE_RUN, ' ').replace(/^ +| +$/g, '');
}
