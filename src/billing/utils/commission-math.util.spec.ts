import { applyBasisPoints } from './commission-math.util';

describe('applyBasisPoints', () => {
  it('computes an exact percentage with no remainder', () => {
    expect(applyBasisPoints(1000n, 500)).toBe(50n); // 1000 * 5% = 50
  });

  it('rounds a fractional minor-unit result half up, deterministically', () => {
    // 100005 minor units * 0.05% (5 bp) = 50.0025 -> rounds down to 50
    expect(applyBasisPoints(100005n, 5)).toBe(50n);
    // 999 * 5% = 49.95 -> rounds up to 50
    expect(applyBasisPoints(999n, 500)).toBe(50n);
    // 999 * 50% (exact half boundary case) — 499.5 -> rounds up to 500
    expect(applyBasisPoints(999n, 5000)).toBe(500n);
  });

  it('returns 0 for a 0% rate', () => {
    expect(applyBasisPoints(123456n, 0)).toBe(0n);
  });

  it('returns the full amount for a 100% rate', () => {
    expect(applyBasisPoints(123456n, 10000)).toBe(123456n);
  });

  it('is deterministic across repeated calls with the same inputs', () => {
    const results = Array.from({ length: 5 }, () => applyBasisPoints(333333n, 333));
    expect(new Set(results.map(String)).size).toBe(1);
  });

  it('never uses floating-point-lossy magnitudes — exact for an amount beyond Number.MAX_SAFE_INTEGER', () => {
    const bigAmount = 9_007_199_254_740_993n; // 2^53 + 1, not exactly representable as a Number
    expect(applyBasisPoints(bigAmount, 10000)).toBe(bigAmount);
  });
});
