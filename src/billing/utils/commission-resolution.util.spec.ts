import { resolveEffectiveCommission } from './commission-resolution.util';

describe('resolveEffectiveCommission', () => {
  it('resolves an exempt Organization to 0 basis points regardless of plan tier or the global default', () => {
    expect(resolveEffectiveCommission('exempt', null, 750, 1000)).toEqual({
      resolved: true,
      basisPoints: 0,
      source: 'exempt',
    });
    expect(resolveEffectiveCommission('exempt', null, null, null)).toEqual({
      resolved: true,
      basisPoints: 0,
      source: 'exempt',
    });
  });

  it('resolves a custom Organization to its own percentage, ignoring plan tier and the global default', () => {
    expect(resolveEffectiveCommission('custom', 500, 750, 1000)).toEqual({
      resolved: true,
      basisPoints: 500,
      source: 'custom',
    });
  });

  it('fails closed for a custom Organization with no percentage recorded (data-integrity defense)', () => {
    expect(resolveEffectiveCommission('custom', null, null, 1000)).toEqual({
      resolved: false,
    });
    expect(resolveEffectiveCommission('custom', undefined, null, 1000)).toEqual({
      resolved: false,
    });
  });

  it('resolves a default-mode Organization to its Plan-tier commission when one is configured, ahead of the global default', () => {
    expect(resolveEffectiveCommission('default', null, 750, 1000)).toEqual({
      resolved: true,
      basisPoints: 750,
      source: 'plan',
    });
  });

  it('treats no row (undefined mode) identically to an explicit default row for the plan tier too', () => {
    expect(resolveEffectiveCommission(undefined, undefined, 750, 1000)).toEqual({
      resolved: true,
      basisPoints: 750,
      source: 'plan',
    });
  });

  it('allows a legitimate 0% plan-tier commission, distinct from "no plan tier configured" — resolved true, source plan, not the global default', () => {
    expect(resolveEffectiveCommission('default', null, 0, 1000)).toEqual({
      resolved: true,
      basisPoints: 0,
      source: 'plan',
    });
  });

  it('falls through to the global default when default mode has no plan-tier commission configured', () => {
    expect(resolveEffectiveCommission('default', null, null, 1000)).toEqual({
      resolved: true,
      basisPoints: 1000,
      source: 'default',
    });
  });

  it('treats no row (undefined mode) identically to an explicit default row when no plan tier applies', () => {
    expect(resolveEffectiveCommission(undefined, undefined, null, 1000)).toEqual({
      resolved: true,
      basisPoints: 1000,
      source: 'default',
    });
  });

  it('resolves to unresolved — never a fabricated 0% — when no tier (plan or global) is configured', () => {
    expect(resolveEffectiveCommission('default', null, null, null)).toEqual({
      resolved: false,
    });
    expect(resolveEffectiveCommission(undefined, undefined, null, null)).toEqual({
      resolved: false,
    });
  });

  it('allows a legitimate 0% global default, distinct from "unset" — resolved true, not false', () => {
    expect(resolveEffectiveCommission('default', null, null, 0)).toEqual({
      resolved: true,
      basisPoints: 0,
      source: 'default',
    });
  });
});
