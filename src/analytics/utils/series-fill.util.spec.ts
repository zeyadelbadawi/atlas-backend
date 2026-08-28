import { fillFlowSeries, fillCumulativeSeries } from './series-fill.util';

describe('fillFlowSeries', () => {
  it('fills missing days with 0', () => {
    const days = ['2026-08-01', '2026-08-02', '2026-08-03'];
    const byDay = new Map([['2026-08-02', 5]]);
    expect(fillFlowSeries(days, byDay)).toEqual([0, 5, 0]);
  });
});

describe('fillCumulativeSeries', () => {
  it('carries the running total forward across days with no new rows', () => {
    const days = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04'];
    const newCounts = new Map([
      ['2026-08-01', 2],
      ['2026-08-03', 3],
    ]);
    expect(fillCumulativeSeries(days, newCounts, 10)).toEqual([12, 12, 15, 15]);
  });

  it('starts from the baseline when there are no new rows at all', () => {
    const days = ['2026-08-01', '2026-08-02'];
    expect(fillCumulativeSeries(days, new Map(), 7)).toEqual([7, 7]);
  });
});
