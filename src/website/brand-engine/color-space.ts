/**
 * Brand engine — colour spaces and contrast (Theme 1 plan §F.4).
 *
 * MIRRORED MODULE. A copy (formatting aside) of the frontend original,
 * `atlas/src/features/website/brand-engine/`, like every file in this
 * folder. Both repositories run the same golden vectors
 * (`__golden__/bp-1.golden.json`): that is what keeps the browser preview
 * and this API's authority computing identical palettes. Change the
 * frontend first, regenerate the vectors there, copy both here.
 *
 * Pure functions, no dependencies. Colours cross the module boundary as
 * the `"H S% L%"` integer triplets Atlas already stores
 * (`HSL_TRIPLET_REGEX`); inside, OKLab/OKLCH (Björn Ottosson, 2020) is used
 * for perceptual work and WCAG 2.x relative luminance for contrast.
 */

/** Gamma-encoded sRGB, each channel 0..1. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface Oklab {
  readonly L: number;
  readonly a: number;
  readonly b: number;
}

/** `h` in degrees [0, 360). */
export interface Oklch {
  readonly L: number;
  readonly C: number;
  readonly h: number;
}

/** The stored colour format: `"H S% L%"`, integers (e.g. `"221 83% 53%"`). */
export type HslTriplet = string;

const TRIPLET_PATTERN = /^(\d{1,3}) (\d{1,3})% (\d{1,3})%$/;

export function isHslTriplet(value: unknown): value is HslTriplet {
  if (typeof value !== 'string') return false;
  const match = TRIPLET_PATTERN.exec(value);
  if (!match) return false;
  const [h, s, l] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return h <= 360 && s <= 100 && l <= 100;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function normalizeHue(h: number): number {
  const wrapped = h % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Shortest angular distance between two hues, 0..180. */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(normalizeHue(a) - normalizeHue(b));
  return d > 180 ? 360 - d : d;
}

// ── sRGB ↔ HSL ────────────────────────────────────────────────────────────

export function hslToRgb(h: number, s: number, l: number): Rgb {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + normalizeHue(h) / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) =>
    light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: f(0), g: f(8), b: f(4) };
}

export function rgbToHsl(rgb: Rgb): { h: number; s: number; l: number } {
  const r = clamp01(rgb.r);
  const g = clamp01(rgb.g);
  const b = clamp01(rgb.b);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: normalizeHue(h * 60), s: s * 100, l: l * 100 };
}

export function parseHslTriplet(triplet: HslTriplet): Rgb {
  const match = TRIPLET_PATTERN.exec(triplet);
  if (!match) throw new Error(`Invalid HSL triplet: ${triplet}`);
  return hslToRgb(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** Rounds to the stored integer format. Hue 360 folds to 0. */
export function formatHslTriplet(rgb: Rgb): HslTriplet {
  const { h, s, l } = rgbToHsl(rgb);
  const lightness = Math.round(l);
  // Pure black/white have no saturation, and a grey has no hue: store them
  // canonically (`0 0% 100%`, `0 0% 40%`).
  const saturation = lightness === 0 || lightness === 100 ? 0 : Math.round(s);
  const hue = saturation === 0 ? 0 : Math.round(h) % 360;
  return `${hue} ${saturation}% ${lightness}%`;
}

export function rgbToHex(rgb: Rgb): string {
  const channel = (value: number) =>
    Math.round(clamp01(value) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`;
}

// ── sRGB ↔ OKLab / OKLCH ─────────────────────────────────────────────────

function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function toGamma(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function rgbToOklab(rgb: Rgb): Oklab {
  const r = toLinear(rgb.r);
  const g = toLinear(rgb.g);
  const b = toLinear(rgb.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** Unclamped: channels outside 0..1 mean the colour is out of the sRGB gamut. */
export function oklabToRgb(lab: Oklab): Rgb {
  const l = Math.pow(lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b, 3);
  const m = Math.pow(lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b, 3);
  const s = Math.pow(lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b, 3);
  return {
    r: toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

export function oklabToOklch(lab: Oklab): Oklch {
  const C = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
  const h = C < 1e-7 ? 0 : normalizeHue((Math.atan2(lab.b, lab.a) * 180) / Math.PI);
  return { L: lab.L, C, h };
}

export function oklchToOklab(lch: Oklch): Oklab {
  const radians = (lch.h * Math.PI) / 180;
  return {
    L: lch.L,
    a: lch.C * Math.cos(radians),
    b: lch.C * Math.sin(radians),
  };
}

export function rgbToOklch(rgb: Rgb): Oklch {
  return oklabToOklch(rgbToOklab(rgb));
}

export function tripletToOklch(triplet: HslTriplet): Oklch {
  return rgbToOklch(parseHslTriplet(triplet));
}

function inGamut(rgb: Rgb): boolean {
  const epsilon = 1e-6;
  return [rgb.r, rgb.g, rgb.b].every(
    (channel) => channel >= -epsilon && channel <= 1 + epsilon,
  );
}

/**
 * OKLCH → displayable sRGB, keeping lightness and hue and reducing chroma
 * until the colour fits (CSS Color 4's chroma-reduction approach, by
 * bisection). Lightness is clamped to 0..1 first.
 */
export function gamutMapOklch(lch: Oklch): Rgb {
  const L = clamp01(lch.L);
  const target = { L, C: Math.max(0, lch.C), h: lch.h };
  const direct = oklabToRgb(oklchToOklab(target));
  if (inGamut(direct)) {
    return { r: clamp01(direct.r), g: clamp01(direct.g), b: clamp01(direct.b) };
  }
  let low = 0;
  let high = target.C;
  for (let step = 0; step < 24; step += 1) {
    const mid = (low + high) / 2;
    if (inGamut(oklabToRgb(oklchToOklab({ L, C: mid, h: target.h })))) {
      low = mid;
    } else {
      high = mid;
    }
  }
  const mapped = oklabToRgb(oklchToOklab({ L, C: low, h: target.h }));
  return { r: clamp01(mapped.r), g: clamp01(mapped.g), b: clamp01(mapped.b) };
}

/** OKLCH → stored triplet (gamut-mapped, then rounded). */
export function oklchToTriplet(lch: Oklch): HslTriplet {
  return formatHslTriplet(gamutMapOklch(lch));
}

/** Euclidean distance in OKLab (ΔE_ok). */
export function deltaEOk(a: Oklab, b: Oklab): number {
  return Math.sqrt((a.L - b.L) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2);
}

export function tripletDeltaE(a: HslTriplet, b: HslTriplet): number {
  return deltaEOk(rgbToOklab(parseHslTriplet(a)), rgbToOklab(parseHslTriplet(b)));
}

// ── WCAG 2.x contrast ─────────────────────────────────────────────────────

export function relativeLuminance(rgb: Rgb): number {
  return (
    0.2126 * toLinear(clamp01(rgb.r)) +
    0.7152 * toLinear(clamp01(rgb.g)) +
    0.0722 * toLinear(clamp01(rgb.b))
  );
}

export function contrastRatio(a: HslTriplet, b: HslTriplet): number {
  const la = relativeLuminance(parseHslTriplet(a));
  const lb = relativeLuminance(parseHslTriplet(b));
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/** Rounded the way reports store it (2 decimals, rounded DOWN so a reported pass is never optimistic). */
export function reportedRatio(ratio: number): number {
  return Math.floor(ratio * 100) / 100;
}
