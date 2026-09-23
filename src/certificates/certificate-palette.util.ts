/**
 * The certificate's colour system — one authoritative definition shared by
 * the DTO validation, the renderer and the (server-rendered) live preview.
 *
 * The Client Owner controls FOUR constrained roles; every other colour the
 * renderer needs (soft body text, hairline rules, foil tints) is DERIVED
 * here, never stored, so the palette can never become internally
 * inconsistent and the editor stays small and professional.
 *
 * Defaults reproduce the original Atlas design exactly, so a template that
 * predates customisation — and any already-issued certificate whose snapshot
 * carries no palette — renders identically to before.
 */
import { BadRequestException } from '@nestjs/common';

/** The four author-controlled roles. */
export interface CertificatePalette {
  /** Dominant brand colour: certificate + course titles, seal, primary rules. */
  readonly primary: string;
  /** Metallic foil accent: fine rules, corner marks, seal ring. */
  readonly accent: string;
  /** Heading and body ink. */
  readonly text: string;
  /** Paper / background. */
  readonly background: string;
}

/** The full set the renderer paints with, derived from the four roles. */
export interface RenderPalette {
  readonly paper: string;
  readonly ink: string;
  readonly inkSoft: string;
  readonly accentDeep: string;
  readonly gold: string;
  readonly goldSoft: string;
  readonly rule: string;
}

export const DEFAULT_PALETTE: CertificatePalette = {
  primary: '#1F4E5F',
  accent: '#B08A3E',
  text: '#14303A',
  background: '#FCFBF7',
};

const HEX = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value.trim());
}

export function normalizeHex(value: string): string {
  return value.trim().toLowerCase();
}

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function hexToRgb(hex: string): Rgb {
  const h = hex.trim().replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }: Rgb): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Linear blend: t=0 → a, t=1 → b. */
function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex({
    r: x.r + (y.r - x.r) * t,
    g: x.g + (y.g - x.g) * t,
    b: x.b + (y.b - x.b) * t,
  });
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Accept a partial palette (any subset of the four roles), fall back to the
 * defaults for the rest, and reject anything that would print poorly. Text on
 * paper must clear 4.5:1 (body legibility), the primary brand colour 3:1
 * (large display type / rules), and the paper itself must stay light so the
 * certificate is printer-friendly. Returns the normalised, complete palette.
 */
export function assertReadablePalette(input: Partial<CertificatePalette>): CertificatePalette {
  const palette: CertificatePalette = {
    primary: isHexColor(input.primary) ? normalizeHex(input.primary) : DEFAULT_PALETTE.primary,
    accent: isHexColor(input.accent) ? normalizeHex(input.accent) : DEFAULT_PALETTE.accent,
    text: isHexColor(input.text) ? normalizeHex(input.text) : DEFAULT_PALETTE.text,
    background: isHexColor(input.background)
      ? normalizeHex(input.background)
      : DEFAULT_PALETTE.background,
  };

  // Reject any explicitly-provided value that is not a valid hex colour, so a
  // typo never silently falls back to a default the owner did not choose.
  for (const [role, value] of Object.entries(input)) {
    if (value !== undefined && value !== null && !isHexColor(value)) {
      throw new BadRequestException({
        messageKey: 'errors.certificate.invalidColor',
        meta: { role },
      });
    }
  }

  if (relativeLuminance(palette.background) < 0.6) {
    throw new BadRequestException({ messageKey: 'errors.certificate.backgroundTooDark' });
  }
  if (contrastRatio(palette.text, palette.background) < 4.5) {
    throw new BadRequestException({ messageKey: 'errors.certificate.textContrastTooLow' });
  }
  if (contrastRatio(palette.primary, palette.background) < 3) {
    throw new BadRequestException({ messageKey: 'errors.certificate.primaryContrastTooLow' });
  }
  return palette;
}

/** Read the four roles off a template row (or anything shaped like it). */
export function paletteFromTemplate(row: {
  readonly primaryColor?: string | null;
  readonly accentColor?: string | null;
  readonly textColor?: string | null;
  readonly backgroundColor?: string | null;
}): CertificatePalette {
  return {
    primary: isHexColor(row.primaryColor) ? normalizeHex(row.primaryColor) : DEFAULT_PALETTE.primary,
    accent: isHexColor(row.accentColor) ? normalizeHex(row.accentColor) : DEFAULT_PALETTE.accent,
    text: isHexColor(row.textColor) ? normalizeHex(row.textColor) : DEFAULT_PALETTE.text,
    background: isHexColor(row.backgroundColor)
      ? normalizeHex(row.backgroundColor)
      : DEFAULT_PALETTE.background,
  };
}

/**
 * Derive the complete render palette from the four roles. This is the ONE
 * function the PDF renderer and the preview both call, so what the owner sees
 * in the editor is what the PDF paints.
 */
export function deriveRenderPalette(
  input: Partial<CertificatePalette> | null | undefined,
): RenderPalette {
  const p: CertificatePalette = {
    primary: isHexColor(input?.primary) ? normalizeHex(input!.primary!) : DEFAULT_PALETTE.primary,
    accent: isHexColor(input?.accent) ? normalizeHex(input!.accent!) : DEFAULT_PALETTE.accent,
    text: isHexColor(input?.text) ? normalizeHex(input!.text!) : DEFAULT_PALETTE.text,
    background: isHexColor(input?.background)
      ? normalizeHex(input!.background!)
      : DEFAULT_PALETTE.background,
  };
  return {
    paper: p.background,
    ink: p.text,
    inkSoft: mix(p.text, p.background, 0.42),
    accentDeep: p.primary,
    gold: p.accent,
    goldSoft: mix(p.accent, p.background, 0.5),
    rule: mix(p.text, p.background, 0.82),
  };
}
