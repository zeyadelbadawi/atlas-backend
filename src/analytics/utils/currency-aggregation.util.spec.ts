import { pickDominantCurrencyAmount, sumByCurrency } from './currency-aggregation.util';

describe('sumByCurrency', () => {
  it('sums amounts grouped by currency, never mixing them', () => {
    const totals = sumByCurrency([
      { currency: 'USD', amountMinorUnits: 100n },
      { currency: 'USD', amountMinorUnits: 200n },
      { currency: 'EUR', amountMinorUnits: 50n },
    ]);
    expect(totals.get('USD')).toBe(300n);
    expect(totals.get('EUR')).toBe(50n);
  });
});

describe('pickDominantCurrencyAmount', () => {
  it('returns the fallback zero amount when there is no data', () => {
    expect(pickDominantCurrencyAmount([])).toEqual({ amount: 0, currency: 'USD' });
  });

  it('reports a single currency directly, as a decimal', () => {
    expect(
      pickDominantCurrencyAmount([
        { currency: 'USD', amountMinorUnits: 7900n },
        { currency: 'USD', amountMinorUnits: 2100n },
      ]),
    ).toEqual({ amount: 100, currency: 'USD' });
  });

  it('never sums two different currencies together — reports only the larger one', () => {
    const result = pickDominantCurrencyAmount([
      { currency: 'USD', amountMinorUnits: 10000n },
      { currency: 'EUR', amountMinorUnits: 500n },
    ]);
    expect(result.currency).toBe('USD');
    expect(result.amount).toBe(100);
  });
});
