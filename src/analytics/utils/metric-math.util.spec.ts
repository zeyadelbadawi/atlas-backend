import {
  safeChangePercent,
  safeRatePercent,
  minorUnitsToDecimal,
} from './metric-math.util';

describe('safeChangePercent', () => {
  it('computes a positive change', () => {
    expect(safeChangePercent(150, 100)).toBe(50);
  });

  it('computes a negative change', () => {
    expect(safeChangePercent(50, 100)).toBe(-50);
  });

  it('returns undefined when the previous value is zero (never divides by zero)', () => {
    expect(safeChangePercent(10, 0)).toBeUndefined();
    expect(safeChangePercent(0, 0)).toBeUndefined();
  });

  it('returns 0 when current equals previous and both are non-zero', () => {
    expect(safeChangePercent(42, 42)).toBe(0);
  });
});

describe('safeRatePercent', () => {
  it('computes a percentage, clamped to [0, 100]', () => {
    expect(safeRatePercent(25, 100)).toBe(25);
    expect(safeRatePercent(100, 100)).toBe(100);
  });

  it('returns 0 when the denominator is zero or negative (never NaN/Infinity)', () => {
    expect(safeRatePercent(10, 0)).toBe(0);
    expect(safeRatePercent(0, 0)).toBe(0);
  });

  it('never exceeds 100 even if the numerator exceeds the denominator', () => {
    expect(safeRatePercent(150, 100)).toBe(100);
  });

  it('never goes below 0', () => {
    expect(safeRatePercent(-10, 100)).toBe(0);
  });
});

describe('minorUnitsToDecimal', () => {
  it('converts integer minor units to a display decimal (2-decimal-exponent convention)', () => {
    expect(minorUnitsToDecimal(7900n)).toBe(79);
    expect(minorUnitsToDecimal(999)).toBe(9.99);
    expect(minorUnitsToDecimal(0n)).toBe(0);
  });
});
