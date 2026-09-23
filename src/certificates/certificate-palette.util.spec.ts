import { BadRequestException } from '@nestjs/common';
import {
  assertReadablePalette,
  contrastRatio,
  DEFAULT_PALETTE,
  deriveRenderPalette,
  paletteFromTemplate,
} from './certificate-palette.util';

describe('certificate palette (P4 Issue G)', () => {
  describe('assertReadablePalette', () => {
    it('accepts a strong, print-friendly palette and normalises the hex', () => {
      const p = assertReadablePalette({
        primary: '#7A1F2B',
        accent: '#C9A227',
        text: '#201A17',
        background: '#FFFDF8',
      });
      expect(p).toEqual({
        primary: '#7a1f2b',
        accent: '#c9a227',
        text: '#201a17',
        background: '#fffdf8',
      });
    });

    it('fills missing roles from the defaults (original Atlas design)', () => {
      expect(assertReadablePalette({})).toEqual(DEFAULT_PALETTE);
      expect(assertReadablePalette({ primary: '#123456' }).accent).toBe(DEFAULT_PALETTE.accent);
    });

    it('rejects a text/background pair that fails 4.5:1', () => {
      expect(() =>
        assertReadablePalette({ text: '#BBBBBB', background: '#FFFFFF' }),
      ).toThrow(BadRequestException);
    });

    it('rejects a dark background (must stay light for print)', () => {
      expect(() =>
        assertReadablePalette({ text: '#FFFFFF', background: '#101010' }),
      ).toThrow(BadRequestException);
    });

    it('rejects a primary colour with too little contrast on the paper', () => {
      expect(() =>
        assertReadablePalette({ primary: '#F3ECDD', background: '#FCFBF7' }),
      ).toThrow(BadRequestException);
    });

    it('rejects a malformed hex rather than silently defaulting', () => {
      expect(() => assertReadablePalette({ primary: 'teal' })).toThrow(BadRequestException);
      expect(() => assertReadablePalette({ accent: '#12345' })).toThrow(BadRequestException);
    });
  });

  describe('deriveRenderPalette', () => {
    it('returns the original design for an old snapshot with no palette', () => {
      const d = deriveRenderPalette(undefined);
      expect(d.paper).toBe(DEFAULT_PALETTE.background);
      expect(d.ink).toBe(DEFAULT_PALETTE.text);
      expect(d.accentDeep).toBe(DEFAULT_PALETTE.primary);
      expect(d.gold).toBe(DEFAULT_PALETTE.accent);
    });

    it('derives soft tints between the role and the paper, keeping body text readable', () => {
      const d = deriveRenderPalette({
        primary: '#1F4E5F',
        accent: '#B08A3E',
        text: '#14303A',
        background: '#FCFBF7',
      });
      // inkSoft is a blend of text→paper, so it sits strictly between them.
      expect(d.inkSoft).not.toBe(d.ink);
      expect(d.inkSoft).not.toBe(d.paper);
      // and stays legible for secondary text (>= 3:1 on the paper).
      expect(contrastRatio(d.inkSoft, d.paper)).toBeGreaterThanOrEqual(3);
      // rule is a faint hairline, close to the paper.
      expect(contrastRatio(d.rule, d.paper)).toBeLessThan(contrastRatio(d.ink, d.paper));
    });
  });

  describe('paletteFromTemplate', () => {
    it('reads the four columns and falls back per-role for nulls', () => {
      expect(
        paletteFromTemplate({
          primaryColor: '#111111',
          accentColor: null,
          textColor: '#222222',
          backgroundColor: undefined,
        }),
      ).toEqual({
        primary: '#111111',
        accent: DEFAULT_PALETTE.accent,
        text: '#222222',
        background: DEFAULT_PALETTE.background,
      });
    });
  });
});
