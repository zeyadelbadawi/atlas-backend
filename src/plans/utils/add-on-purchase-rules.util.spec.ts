import { isPlanCompatibleWithAddOn, isPricedAddOn } from './add-on-purchase-rules.util';

describe('isPricedAddOn', () => {
  it('treats a positive amount as priced', () => {
    expect(isPricedAddOn({ amount: 15, currency: 'USD', billingCycle: 'monthly' })).toBe(
      true,
    );
    expect(isPricedAddOn({ amount: '450', currency: 'EGP' })).toBe(true);
  });

  it('treats no pricing, a zero amount or a malformed amount as free', () => {
    expect(isPricedAddOn(null)).toBe(false);
    expect(isPricedAddOn(undefined)).toBe(false);
    expect(isPricedAddOn({ amount: 0, currency: 'EGP' })).toBe(false);
    expect(isPricedAddOn({ amount: 'abc' })).toBe(false);
    expect(isPricedAddOn({ currency: 'EGP' })).toBe(false);
    expect(isPricedAddOn('15')).toBe(false);
  });
});

describe('isPlanCompatibleWithAddOn', () => {
  it('allows every plan when the add-on has no restriction', () => {
    expect(isPlanCompatibleWithAddOn([], 'starter')).toBe(true);
    expect(isPlanCompatibleWithAddOn(null, null)).toBe(true);
  });

  it('requires the current plan to be listed when there is a restriction', () => {
    expect(isPlanCompatibleWithAddOn(['growth'], 'growth')).toBe(true);
    expect(isPlanCompatibleWithAddOn(['growth'], 'starter')).toBe(false);
    expect(isPlanCompatibleWithAddOn(['growth'], null)).toBe(false);
  });
});
