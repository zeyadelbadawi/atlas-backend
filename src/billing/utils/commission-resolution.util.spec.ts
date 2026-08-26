import { resolveEffectiveCommission } from './commission-resolution.util';

describe('resolveEffectiveCommission', () => {
  it('resolves an exempt Organization to 0 basis points regardless of the global default', () => {
    expect(resolveEffectiveCommission('exempt', null, 1000)).toEqual({
      resolved: true,
      basisPoints: 0,
      source: 'exempt',
    });
    expect(resolveEffectiveCommission('exempt', null, null)).toEqual({
      resolved: true,
      basisPoints: 0,
      source: 'exempt',
    });
  });

  it('resolves a custom Organization to its own percentage, ignoring the global default', () => {
    expect(resolveEffectiveCommission('custom', 500, 1000)).toEqual({
      resolved: true,
      basisPoints: 500,
      source: 'custom',
    });
  });

  it('fails closed for a custom Organization with no percentage recorded (data-integrity defense)', () => {
    expect(resolveEffectiveCommission('custom', null, 1000)).toEqual({ resolved: false });
    expect(resolveEffectiveCommission('custom', undefined, 1000)).toEqual({
      resolved: false,
    });
  });

  it('resolves a default-mode Organization to the global default when one is configured', () => {
    expect(resolveEffectiveCommission('default', null, 1000)).toEqual({
      resolved: true,
      basisPoints: 1000,
      source: 'default',
    });
  });

  it('treats no row (undefined mode) identically to an explicit default row', () => {
    expect(resolveEffectiveCommission(undefined, undefined, 1000)).toEqual({
      resolved: true,
      basisPoints: 1000,
      source: 'default',
    });
  });

  it('resolves to unresolved — never a fabricated 0% — when default mode has no global default configured', () => {
    expect(resolveEffectiveCommission('default', null, null)).toEqual({
      resolved: false,
    });
    expect(resolveEffectiveCommission(undefined, undefined, null)).toEqual({
      resolved: false,
    });
  });

  it('allows a legitimate 0% global default, distinct from "unset" — resolved true, not false', () => {
    expect(resolveEffectiveCommission('default', null, 0)).toEqual({
      resolved: true,
      basisPoints: 0,
      source: 'default',
    });
  });
});
