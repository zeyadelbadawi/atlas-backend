import { BadRequestException } from '@nestjs/common';
import { assertCountryAllowed, isCountryCode } from './country-code';

describe('academy country codes (D5-3)', () => {
  it('accepts upper-case ISO 3166-1 alpha-2 codes', () => {
    for (const code of ['EG', 'SA', 'AE', 'US']) expect(isCountryCode(code)).toBe(true);
  });

  it.each(['eg', 'Egypt', 'EGY', 'ZZ', 'E', '', '20'])('refuses %p', (value) => {
    expect(isCountryCode(value)).toBe(false);
  });

  it.each([
    ['absent', undefined, 'Egypt'],
    ['null', null, undefined],
    ['empty (clears the country)', '', 'EG'],
    ['a known code', 'SA', 'EG'],
    ['an unchanged legacy value', 'Egypt', 'Egypt'],
  ])('allows %s', (_label, next, current) => {
    expect(() => assertCountryAllowed(next, current, 'address.country')).not.toThrow();
  });

  it.each([
    ['a display name', 'Egypt', 'EG'],
    ['a lower-case code', 'eg', undefined],
    ['an unknown code', 'ZZ', null],
    ['a switch between legacy values', 'Saudi Arabia', 'Egypt'],
  ])('refuses %s, as a field violation', (_label, next, current) => {
    let error: unknown;
    try {
      assertCountryAllowed(next, current, 'address.country');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toEqual({
      messageKey: 'errors.validation.failed',
      violations: [{ field: 'address.country', messageKey: 'validation:invalidCountry' }],
    });
  });
});
