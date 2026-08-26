import { toMinorUnits } from './money.util';

describe('toMinorUnits', () => {
  it('converts a display-unit amount to integer minor units', () => {
    expect(toMinorUnits(79)).toBe(7900n);
    expect(toMinorUnits(0)).toBe(0n);
    expect(toMinorUnits(9.99)).toBe(999n);
  });

  it('rounds, rather than truncates, floating-point noise', () => {
    expect(toMinorUnits(10.005)).toBe(1001n); // 10.005 * 100 = 1000.4999999... in IEEE754
  });
});
