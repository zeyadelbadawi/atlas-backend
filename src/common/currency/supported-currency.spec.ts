import { BadRequestException } from '@nestjs/common';
import { assertCurrencyAllowed, SUPPORTED_CURRENCIES } from './supported-currency';

describe('assertCurrencyAllowed (B0-LRN-05 / B0-COM-05)', () => {
  it('supports EGP only for now', () => {
    expect(SUPPORTED_CURRENCIES).toEqual(['EGP']);
  });

  it.each([
    ['absent', undefined, 'USD'],
    ['null', null, 'USD'],
    ['supported', 'EGP', null],
    ['unchanged legacy value', 'USD', 'USD'],
  ])('allows %s', (_label, next, current) => {
    expect(() => assertCurrencyAllowed(next, current, 'currency')).not.toThrow();
  });

  it.each([
    ['a new unsupported value', 'USD', undefined],
    ['a switch between unsupported values', 'SAR', 'USD'],
    ['a lower-case code', 'egp', 'EGP'],
  ])('refuses %s, as a field violation', (_label, next, current) => {
    let error: unknown;
    try {
      assertCurrencyAllowed(next, current, 'pricing.currency');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toEqual({
      messageKey: 'errors.validation.failed',
      violations: [
        { field: 'pricing.currency', messageKey: 'validation:unsupportedCurrency' },
      ],
    });
  });
});
