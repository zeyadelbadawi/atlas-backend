import { cleanDisplayName, isEmptyNameKey, normalizeNameKey } from './name-key';
import { NAME_KEY_CORPUS } from './name-key.corpus';

describe('normalizeNameKey (TypeScript mirror of atlas_name_key)', () => {
  it.each(NAME_KEY_CORPUS)('$label', ({ value, expected }) => {
    expect(normalizeNameKey(value)).toBe(expected);
  });

  it('folds the investigation’s equivalence classes together', () => {
    const key = (v: string) => normalizeNameKey(v);
    expect(key('مُحَمَّد أَحْمَد')).toBe(key('ﻣﺤﻤﺪ احمد'));
    expect(key('José Café')).toBe(key('JOSE CAFE'));
    expect(key('ΣΑΣ')).toBe(key('σασ'));
  });

  it('keeps the conservative distinctions (ى/ي, ة/ه, digits)', () => {
    expect(normalizeNameKey('مصطفى')).not.toBe(normalizeNameKey('مصطفي'));
    expect(normalizeNameKey('فاطمة')).not.toBe(normalizeNameKey('فاطمه'));
    expect(normalizeNameKey('Academy ٣')).not.toBe(normalizeNameKey('Academy 3'));
  });

  it('flags names with nothing comparable', () => {
    expect(isEmptyNameKey('ـ‍ ')).toBe(true);
    expect(isEmptyNameKey('A')).toBe(false);
  });

  it('cleans the display value without changing letters', () => {
    expect(cleanDisplayName('  Acme    Academy  ')).toBe('Acme Academy');
    expect(cleanDisplayName('José')).toBe('José');
  });
});
