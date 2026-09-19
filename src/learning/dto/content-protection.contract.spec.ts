/**
 * P64 Phase 2 — per-academy content-protection settings (master plan D8,
 * Phase 2 §D.9).
 *
 * WHY THESE TESTS EXIST. This blob is JSON in a column: nothing in the
 * database schema constrains its shape, so the resolver IS the schema. The
 * value can be null (every academy until an owner touches it), a
 * half-written object from an older release, or — if anything ever writes
 * it carelessly — a string, a number or an array.
 *
 * The rule the whole file turns on is that the failure mode must be MORE
 * protection than the owner asked for, never less: being over-protected is
 * a support ticket, being under-protected is content that has already
 * leaked. So every "I do not understand this value" path below is asserted
 * to land on the full-protection defaults.
 *
 * The mirror of that rule is equally important and is the easiest thing to
 * break with a naive `{ ...defaults, ...stored }`-style merge in reverse:
 * an owner who deliberately turned something OFF must stay off. A default
 * that overwrote an explicit `false` would silently re-enable a watermark
 * an academy chose not to show.
 */
import {
  DEFAULT_CONTENT_PROTECTION,
  resolveContentProtection,
} from './content-protection.contract';

describe('resolveContentProtection — the defaults are the stronger setting', () => {
  it('pins what "full protection" actually means', () => {
    // Every fallback below is only safe because these are all-on.
    expect(DEFAULT_CONTENT_PROTECTION).toEqual({
      watermark: true,
      watermarkText: null,
      disableDownload: true,
      disablePip: true,
      disableContextMenu: true,
    });
  });

  it('resolves null to the defaults (the state every academy starts in)', () => {
    expect(resolveContentProtection(null)).toEqual(DEFAULT_CONTENT_PROTECTION);
  });

  it('resolves undefined to the defaults', () => {
    expect(resolveContentProtection(undefined)).toEqual(DEFAULT_CONTENT_PROTECTION);
  });

  it('resolves an array to the defaults rather than reading indexes off it', () => {
    expect(resolveContentProtection([])).toEqual(DEFAULT_CONTENT_PROTECTION);
    expect(resolveContentProtection([{ watermark: false }])).toEqual(
      DEFAULT_CONTENT_PROTECTION,
    );
  });

  it('resolves a string to the defaults', () => {
    // Including a string that happens to be JSON: this function takes a
    // parsed value, and must not quietly parse one itself.
    expect(resolveContentProtection('{"watermark":false}')).toEqual(
      DEFAULT_CONTENT_PROTECTION,
    );
    expect(resolveContentProtection('')).toEqual(DEFAULT_CONTENT_PROTECTION);
  });

  it('resolves other scalars to the defaults', () => {
    expect(resolveContentProtection(0)).toEqual(DEFAULT_CONTENT_PROTECTION);
    expect(resolveContentProtection(42)).toEqual(DEFAULT_CONTENT_PROTECTION);
    expect(resolveContentProtection(false)).toEqual(DEFAULT_CONTENT_PROTECTION);
    expect(resolveContentProtection(true)).toEqual(DEFAULT_CONTENT_PROTECTION);
  });

  it('resolves an empty object to the defaults', () => {
    expect(resolveContentProtection({})).toEqual(DEFAULT_CONTENT_PROTECTION);
  });
});

describe('resolveContentProtection — partial and explicit values', () => {
  it('fills the keys a partial object is missing from the defaults', () => {
    expect(resolveContentProtection({ disablePip: false })).toEqual({
      watermark: true,
      watermarkText: null,
      disableDownload: true,
      disablePip: false,
      disableContextMenu: true,
    });
  });

  /*
   * THE OTHER DIRECTION. An owner who turned a deterrent off must stay
   * off — a default that won here would re-enable a watermark an academy
   * deliberately removed.
   */
  it('honours every explicit false rather than overwriting it with a default', () => {
    expect(
      resolveContentProtection({
        watermark: false,
        disableDownload: false,
        disablePip: false,
        disableContextMenu: false,
      }),
    ).toEqual({
      watermark: false,
      watermarkText: null,
      disableDownload: false,
      disablePip: false,
      disableContextMenu: false,
    });
  });

  it('honours explicit true values', () => {
    expect(
      resolveContentProtection({
        watermark: true,
        disableDownload: true,
        disablePip: true,
        disableContextMenu: true,
      }),
    ).toEqual(DEFAULT_CONTENT_PROTECTION);
  });

  /* A non-boolean is not a decision — it falls back to the stronger setting. */
  it('falls back to the default for a key that is not a boolean', () => {
    expect(
      resolveContentProtection({
        watermark: 'false',
        disableDownload: 0,
        disablePip: null,
        disableContextMenu: [],
      }),
    ).toEqual(DEFAULT_CONTENT_PROTECTION);
  });

  it('ignores unknown keys instead of passing them through', () => {
    const resolved = resolveContentProtection({
      watermark: false,
      somethingElse: 'ignored',
    });
    expect(resolved).toEqual({
      watermark: false,
      watermarkText: null,
      disableDownload: true,
      disablePip: true,
      disableContextMenu: true,
    });
    expect(Object.keys(resolved).sort()).toEqual(
      Object.keys(DEFAULT_CONTENT_PROTECTION).sort(),
    );
  });
});

describe('resolveContentProtection — watermarkText', () => {
  /*
   * Null means "use the viewer's own short id", which is the identifying
   * overlay the watermark exists for. A blank string is not an override,
   * it is an empty overlay — so blank must become null rather than
   * silently switching the watermark off while claiming it is on.
   */
  it('resolves a blank string to null', () => {
    expect(resolveContentProtection({ watermarkText: '' }).watermarkText).toBeNull();
  });

  it('resolves a whitespace-only string to null', () => {
    expect(resolveContentProtection({ watermarkText: '   ' }).watermarkText).toBeNull();
    expect(resolveContentProtection({ watermarkText: '\t\n ' }).watermarkText).toBeNull();
  });

  it('trims and keeps a real override', () => {
    expect(
      resolveContentProtection({ watermarkText: '  Atlas Academy \n' }).watermarkText,
    ).toBe('Atlas Academy');
  });

  it('keeps a real override even when the watermark itself is off', () => {
    // The text is stored settings, not a second switch; `watermark` is the
    // switch, and the two are resolved independently.
    const resolved = resolveContentProtection({
      watermark: false,
      watermarkText: 'Atlas Academy',
    });
    expect(resolved.watermark).toBe(false);
    expect(resolved.watermarkText).toBe('Atlas Academy');
  });

  it('resolves a non-string watermarkText to null', () => {
    expect(resolveContentProtection({ watermarkText: 42 }).watermarkText).toBeNull();
    expect(resolveContentProtection({ watermarkText: null }).watermarkText).toBeNull();
    expect(
      resolveContentProtection({ watermarkText: { text: 'nope' } }).watermarkText,
    ).toBeNull();
  });
});
