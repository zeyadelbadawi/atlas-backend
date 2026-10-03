/**
 * W4 — the shared normalization corpus (W4 investigation `key_test.sql`,
 * plus the final-sigma, invisibles and empty cases). `expected` is what the
 * SQL `atlas_name_key()` returns; the unit test checks the TypeScript mirror
 * against it, and the e2e parity test (`test/w4-name-uniqueness.e2e-spec.ts`)
 * checks the database function against the same rows.
 */
export const NAME_KEY_CORPUS: readonly {
  readonly label: string;
  readonly value: string;
  readonly expected: string;
}[] = [
  { label: 'ascii-case', value: '  Acme   Academy ', expected: 'acme academy' },
  { label: 'ascii-case2', value: 'acme academy', expected: 'acme academy' },
  { label: 'nbsp+tab', value: 'Acme \tAcademy', expected: 'acme academy' },
  { label: 'fullwidth', value: 'Ａｃｍｅ Academy', expected: 'acme academy' },
  { label: 'ligature', value: 'ﬁnance hub', expected: 'finance hub' },
  { label: 'latin-accent', value: 'José Café', expected: 'jose cafe' },
  { label: 'latin-noaccent', value: 'jose cafe', expected: 'jose cafe' },
  { label: 'greek', value: 'ΣΑΣ', expected: 'σασ' },
  { label: 'greek2', value: 'σασ', expected: 'σασ' },
  { label: 'zero-width', value: 'Acme​ Academy', expected: 'acme academy' },
  { label: 'bidi-mark', value: '‏Acme Academy', expected: 'acme academy' },
  { label: 'bom+isolates', value: '﻿⁦Acme⁩ Academy', expected: 'acme academy' },
  { label: 'ar-plain', value: 'محمد احمد', expected: 'محمد احمد' },
  { label: 'ar-harakat', value: 'مُحَمَّد أَحْمَد', expected: 'محمد احمد' },
  { label: 'ar-tatweel', value: 'محـــمد أحمد', expected: 'محمد احمد' },
  { label: 'ar-hamza-alef', value: 'محمد أحمد', expected: 'محمد احمد' },
  { label: 'ar-alef-madda', value: 'آمنة', expected: 'امنة' },
  { label: 'ar-plain-amna', value: 'امنة', expected: 'امنة' },
  { label: 'ar-pres-form', value: 'ﻣﺤﻤﺪ احمد', expected: 'محمد احمد' },
  { label: 'ar-ya-maqsura', value: 'مصطفى', expected: 'مصطفى' },
  { label: 'ar-ya', value: 'مصطفي', expected: 'مصطفي' },
  { label: 'ar-ta-marbuta', value: 'فاطمة', expected: 'فاطمة' },
  { label: 'ar-ha', value: 'فاطمه', expected: 'فاطمه' },
  { label: 'ar-indic-digits', value: 'أكاديمية ٣', expected: 'اكاديمية ٣' },
  { label: 'ideographic-space', value: 'Acme　Academy', expected: 'acme academy' },
  { label: 'empty-marks', value: 'َ​  ', expected: '' },
];
