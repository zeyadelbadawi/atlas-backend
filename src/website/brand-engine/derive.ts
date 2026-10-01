/**
 * Brand engine — role derivation (Theme 1 plan §F.4.2 steps 6–8, §F.4.4).
 *
 * MIRRORED MODULE — see `color-space.ts`.
 *
 * Seeds are brand identity inputs, never UI colours: every role is derived
 * from them in OKLCH (keep the hue, keep chroma where possible, move
 * lightness) and checked against the §F.4.4 contrast matrix. Every check is
 * made on the ROUNDED triplet that will actually be stored, so rounding can
 * never turn a pass into a fail. Deterministic: same input → same palette.
 */
import {
  contrastRatio,
  hueDistance,
  normalizeHue,
  oklchToTriplet,
  reportedRatio,
  tripletToOklch,
  type HslTriplet,
  type Oklch,
} from './color-space';
import { scoreHarmony } from './harmony';
import {
  BRAND_CONTRAST_PAIRS,
  BRAND_ENGINE_ALGORITHM_VERSION,
  BRAND_PALETTE_SCHEMA_VERSION,
  BRAND_PALETTE_VARIANTS,
  BRAND_ROLE_NAMES,
  BRAND_SEED_NAMES,
  type BrandColorRef,
  type BrandExtraction,
  type BrandOverrides,
  type BrandPalette,
  type BrandPaletteReport,
  type BrandPaletteSource,
  type BrandPaletteStatus,
  type BrandPaletteVariant,
  type BrandRoleName,
  type BrandRoles,
  type BrandSeedName,
  type BrandSeeds,
  type ContrastPairResult,
  type PaletteAdjustment,
  type SeedUsage,
} from './palette.types';

export const WHITE: HslTriplet = '0 0% 100%';

/** Theme 1's cap on how much the brand hue may tint neutrals (§F.4.2 step 6). */
export const DEFAULT_NEUTRAL_CHROMA_CAP = 0.012;

/** Accent source for a brand with no usable hue (monochrome / "ink brand"). */
export const DEFAULT_FALLBACK_ACCENT: HslTriplet = '38 92% 55%';

/** Below this chroma a colour has no meaningful hue. */
const ACHROMATIC_CHROMA = 0.03;
const LIGHTNESS_STEP = 0.005;
/** Hover / pressed: this much OKLCH lightness away from the label colour, each step (§F.4.2 "L ± 6"). */
const STATE_STEP = 0.06;
/** Lightness of an accent filled in by harmony (the brand gave none). */
const HARMONY_ACCENT_LIGHTNESS = 0.8;

const VARIANT_CHROMA: Record<BrandPaletteVariant, number> = {
  balanced: 1,
  vivid: 1.25,
  calm: 0.6,
  secondaryLed: 1,
};

/** Hue family, target chroma and the brand-hue collision window for each status role. */
const STATUS_ROLES = [
  { role: 'success', hue: 145, chroma: 0.14 },
  { role: 'warning', hue: 75, chroma: 0.14 },
  { role: 'error', hue: 25, chroma: 0.16 },
] as const;
const STATUS_MAX_NUDGE = 10;
const STATUS_COLLISION_HUE = 20;
const STATUS_SEPARATION_L = 0.1;

export interface DeriveBrandPaletteOptions {
  readonly variant?: BrandPaletteVariant;
  /** Owner choices; seeds re-derive their dependents, roles replace the derived value. */
  readonly overrides?: BrandOverrides;
  /** How much the brand hue may tint background/surface/border (theme cap). */
  readonly neutralChromaCap?: number;
  /** Accent when the brand has no hue of its own. */
  readonly fallbackAccent?: HslTriplet;
}

export interface DerivedBrandPalette {
  /** The identity inputs, overrides applied, missing ones filled by harmony. */
  readonly seeds: Required<BrandSeeds>;
  readonly roles: BrandRoles;
  readonly usage: Readonly<Record<BrandSeedName, SeedUsage>>;
  readonly report: BrandPaletteReport;
}

/**
 * Nearest lightness (from `base.L`, darker first on a tie) whose rounded
 * triplet passes `passes`. Hue and chroma are kept; chroma only drops where
 * the gamut forces it. `null` only if no lightness at all can pass.
 */
export function solveLightness(
  base: Oklch,
  passes: (candidate: HslTriplet) => boolean,
  direction: 'nearest' | 'darker' | 'lighter' = 'nearest',
): HslTriplet | null {
  const maxSteps = Math.ceil(1 / LIGHTNESS_STEP);
  const seen = new Set<string>();
  const tryLightness = (L: number): HslTriplet | null => {
    if (L < 0 || L > 1) return null;
    const candidate = oklchToTriplet({ ...base, L });
    if (seen.has(candidate)) return null;
    seen.add(candidate);
    return passes(candidate) ? candidate : null;
  };
  for (let step = 0; step <= maxSteps; step += 1) {
    const offset = step * LIGHTNESS_STEP;
    if (direction !== 'lighter') {
      const darker = tryLightness(base.L - offset);
      if (darker) return darker;
    }
    if (direction !== 'darker' && step > 0) {
      const lighter = tryLightness(base.L + offset);
      if (lighter) return lighter;
    }
  }
  return null;
}

/**
 * Hover and pressed shades of `cta`: moved AWAY from the label colour, so
 * each state keeps (in practice raises) the label's contrast. Shared by
 * derivation, validation and every theme mapping, so all three agree.
 */
export function deriveInteractionStates(
  cta: HslTriplet,
  ctaForeground: HslTriplet,
): { ctaHover: HslTriplet; ctaPressed: HslTriplet } {
  const base = tripletToOklch(cta);
  const labelLightness = tripletToOklch(ctaForeground).L;
  const sign = labelLightness >= base.L ? -1 : 1;
  return {
    ctaHover: oklchToTriplet({ ...base, L: base.L + sign * STATE_STEP }),
    ctaPressed: oklchToTriplet({ ...base, L: base.L + sign * 2 * STATE_STEP }),
  };
}

/** Resolves a pair reference (role or derived state) against a set of roles. */
export function resolveColorRef(roles: BrandRoles, ref: BrandColorRef): HslTriplet {
  if (ref === 'ctaHover' || ref === 'ctaPressed') {
    return deriveInteractionStates(roles.cta, roles.ctaForeground)[ref];
  }
  return roles[ref];
}

/** The §F.4.4 matrix, evaluated. */
export function evaluateContrastPairs(roles: BrandRoles): ContrastPairResult[] {
  return BRAND_CONTRAST_PAIRS.map((pair) => {
    const ratio = contrastRatio(
      resolveColorRef(roles, pair.fg),
      resolveColorRef(roles, pair.bg),
    );
    return {
      fg: pair.fg,
      bg: pair.bg,
      ratio: reportedRatio(ratio),
      required: pair.required,
      pass: ratio >= pair.required,
    };
  });
}

function withChroma(lch: Oklch, factor: number): Oklch {
  return { ...lch, C: lch.C * factor };
}

function passesAll(
  candidate: HslTriplet,
  against: readonly HslTriplet[],
  required: number,
): boolean {
  return against.every((other) => contrastRatio(candidate, other) >= required);
}

/**
 * A fill (cta, secondary) and its label colour: white or ink, whichever
 * needs the smaller lightness shift (§F.4.2). For the CTA, `boundary` also
 * requires 3:1 against the page background (§F.4.4) — a pale or neon brand
 * colour is deepened into a real button rather than kept as a washed-out
 * one (its raw colour stays available for decoration, `usage`).
 */
function deriveFill(
  seed: Oklch,
  ink: HslTriplet,
  cta: { background: HslTriplet } | null,
): { fill: HslTriplet; label: HslTriplet } {
  let best: { fill: HslTriplet; label: HslTriplet; shift: number } | null = null;
  for (const label of [WHITE, ink]) {
    const fill = solveLightness(seed, (candidate) => {
      if (contrastRatio(label, candidate) < 4.5) return false;
      if (!cta) return true;
      if (contrastRatio(candidate, cta.background) < 3) return false;
      const states = deriveInteractionStates(candidate, label);
      return (
        contrastRatio(label, states.ctaHover) >= 4.5 &&
        contrastRatio(label, states.ctaPressed) >= 4.5
      );
    });
    if (!fill) continue;
    const shift = Math.abs(tripletToOklch(fill).L - seed.L);
    // Strictly smaller wins, so white wins a tie.
    if (!best || shift < best.shift - 1e-9) best = { fill, label, shift };
  }
  if (!best) throw new Error('No accessible fill exists for this seed');
  return { fill: best.fill, label: best.label };
}

function signedHueDelta(from: number, to: number): number {
  const d = normalizeHue(to - from);
  return d > 180 ? d - 360 : d;
}

export function deriveBrandPalette(
  inputSeeds: BrandSeeds,
  options: DeriveBrandPaletteOptions = {},
): DerivedBrandPalette {
  const variant = options.variant ?? 'balanced';
  const overrides = options.overrides ?? {};
  const cap = options.neutralChromaCap ?? DEFAULT_NEUTRAL_CHROMA_CAP;
  const fallbackAccent = options.fallbackAccent ?? DEFAULT_FALLBACK_ACCENT;
  const adjustments: PaletteAdjustment[] = [];

  // Seeds: overrides are authoritative; missing ones come from harmony.
  const given: BrandSeeds = {
    primary: overrides.primary ?? inputSeeds.primary,
    secondary: overrides.secondary ?? inputSeeds.secondary,
    accent: overrides.accent ?? inputSeeds.accent,
  };
  const givenPrimary = tripletToOklch(given.primary);
  const achromatic = givenPrimary.C < ACHROMATIC_CHROMA;
  const hueSource = achromatic ? tripletToOklch(fallbackAccent) : givenPrimary;

  let secondarySeed = given.secondary;
  if (!secondarySeed) {
    secondarySeed = oklchToTriplet({
      L: hueSource.L,
      C: hueSource.C,
      h: normalizeHue(hueSource.h + 30),
    });
    adjustments.push({
      target: 'secondary',
      reason: 'harmonyFill',
      to: secondarySeed,
    });
  }
  let accentSeed = given.accent;
  if (!accentSeed) {
    // Split-complement of the primary, as a light highlight colour (a
    // stroke, a dot, a glow) that takes a dark label.
    accentSeed = achromatic
      ? fallbackAccent
      : oklchToTriplet({
          L: HARMONY_ACCENT_LIGHTNESS,
          C: Math.min(0.16, Math.max(givenPrimary.C, 0.1)),
          h: normalizeHue(givenPrimary.h + 150),
        });
    adjustments.push({
      target: 'accent',
      reason: 'harmonyFill',
      to: accentSeed,
    });
  }
  const seeds: Required<BrandSeeds> = {
    primary: given.primary,
    secondary: secondarySeed,
    accent: accentSeed,
  };

  // The variant decides which seed leads and how much chroma survives.
  const factor = VARIANT_CHROMA[variant];
  const [leadSeed, supportSeed] =
    variant === 'secondaryLed'
      ? [seeds.secondary, seeds.primary]
      : [seeds.primary, seeds.secondary];
  const lead = withChroma(tripletToOklch(leadSeed), factor);
  const support = withChroma(tripletToOklch(supportSeed), factor);
  const accentLch = withChroma(tripletToOklch(seeds.accent), factor);
  const leadAchromatic = lead.C < ACHROMATIC_CHROMA;
  const hue = lead.h;
  const tint = leadAchromatic ? 0 : cap;

  // Neutral canvas, faintly tinted by the lead hue.
  const background = oklchToTriplet({
    L: 0.995,
    C: Math.min(tint, 0.004),
    h: hue,
  });
  const surface = oklchToTriplet({
    L: 0.972,
    C: Math.min(tint, 0.008),
    h: hue,
  });
  const surfaceMuted = oklchToTriplet({ L: 0.948, C: tint, h: hue });
  const inkChroma = leadAchromatic ? 0 : 0.02;

  const foreground = solveLightness(
    { L: 0.24, C: inkChroma, h: hue },
    (c) => passesAll(c, [background, surface], 7),
    'darker',
  )!;
  const foregroundMuted = solveLightness({ L: 0.5, C: inkChroma, h: hue }, (c) =>
    passesAll(c, [background, surface, surfaceMuted], 4.5),
  )!;
  const border = solveLightness(
    { L: 0.7, C: Math.min(tint * 2, 0.02), h: hue },
    (c) => contrastRatio(c, background) >= 3,
  )!;

  const leadRaw = oklchToTriplet(lead);
  const cta = deriveFill(lead, foreground, { background });
  if (cta.fill !== leadRaw) {
    adjustments.push({
      target: 'cta',
      reason: 'contrast',
      from: leadRaw,
      to: cta.fill,
    });
  }
  const supportRaw = oklchToTriplet(support);
  const secondary = deriveFill(support, foreground, null);
  if (secondary.fill !== supportRaw) {
    adjustments.push({
      target: 'secondary',
      reason: 'contrast',
      from: supportRaw,
      to: secondary.fill,
    });
  }

  // Accent: kept as close to the raw seed as possible (§F.4.2).
  const accentRaw = oklchToTriplet(accentLch);
  let accent = accentRaw;
  const bestLabel = (fill: HslTriplet): HslTriplet =>
    contrastRatio(WHITE, fill) >= contrastRatio(foreground, fill) ? WHITE : foreground;
  if (contrastRatio(bestLabel(accent), accent) < 4.5) {
    accent = solveLightness(
      accentLch,
      (c) => contrastRatio(WHITE, c) >= 4.5 || contrastRatio(foreground, c) >= 4.5,
    )!;
    adjustments.push({
      target: 'accent',
      reason: 'contrast',
      from: accentRaw,
      to: accent,
    });
  }
  const accentForeground = bestLabel(accent);

  const link = solveLightness(
    tripletToOklch(cta.fill),
    (c) => passesAll(c, [background, surface], 4.5),
    'darker',
  )!;
  const focus = passesAll(cta.fill, [background, surface], 3)
    ? cta.fill
    : solveLightness(
        tripletToOklch(cta.fill),
        (c) => passesAll(c, [background, surface], 3),
        'darker',
      )!;

  const ctaLightness = tripletToOklch(cta.fill).L;
  const status = {} as Record<'success' | 'warning' | 'error', HslTriplet>;
  for (const spec of STATUS_ROLES) {
    const collides =
      !leadAchromatic && hueDistance(hue, spec.hue) <= STATUS_COLLISION_HUE;
    // Nudged a little toward the brand hue for harmony — never INTO it.
    const nudge = collides
      ? 0
      : leadAchromatic
        ? 0
        : Math.max(
            -STATUS_MAX_NUDGE,
            Math.min(STATUS_MAX_NUDGE, signedHueDelta(spec.hue, hue) * 0.25),
          );
    const base: Oklch = {
      L: 0.52,
      C: spec.chroma,
      h: normalizeHue(spec.hue + nudge),
    };
    const passes = (c: HslTriplet) => passesAll(c, [background, surface], 4.5);
    let color = solveLightness(base, passes, 'darker')!;
    if (
      collides &&
      Math.abs(tripletToOklch(color).L - ctaLightness) < STATUS_SEPARATION_L
    ) {
      // Same hue family as the brand: separate by lightness instead (and
      // status colours always ship with an icon, §F.4.4).
      const from = color;
      color = solveLightness(
        { ...base, L: ctaLightness - STATUS_SEPARATION_L - LIGHTNESS_STEP },
        passes,
        'darker',
      )!;
      adjustments.push({
        target: spec.role,
        reason: 'statusHueCollision',
        from,
        to: color,
      });
    }
    status[spec.role] = color;
  }

  const derived: Record<BrandRoleName, HslTriplet> = {
    primary: cta.fill,
    primaryForeground: cta.label,
    secondary: secondary.fill,
    secondaryForeground: secondary.label,
    accent,
    accentForeground,
    background,
    surface,
    surfaceMuted,
    foreground,
    foregroundMuted,
    border,
    success: status.success,
    warning: status.warning,
    error: status.error,
    focus,
    link,
    cta: cta.fill,
    ctaForeground: cta.label,
  };

  // Owner role overrides are final (validation decides whether they're
  // allowed). `primary`/`secondary`/`accent` name a SEED as well as a role;
  // an override of one of those is a seed override (applied above, its
  // dependents re-derived), never a raw role override.
  const roles = {} as Record<BrandRoleName, HslTriplet>;
  for (const name of BRAND_ROLE_NAMES) {
    const isSeedName = (BRAND_SEED_NAMES as readonly string[]).includes(name);
    roles[name] = (!isSeedName && overrides[name]) || derived[name];
  }

  const usage = {} as Record<BrandSeedName, SeedUsage>;
  for (const name of BRAND_SEED_NAMES) {
    // The accent is used (nearly) raw, so judge the role; the others are
    // only ever inputs, so judge the raw seed.
    const color = name === 'accent' ? roles.accent : seeds[name];
    const ratio = contrastRatio(color, roles.background);
    usage[name] = ratio >= 3 ? 'full' : 'decorativeOnly';
    if (usage[name] === 'decorativeOnly') {
      adjustments.push({
        target: name,
        reason: 'decorativeOnly',
        from: color,
        ratio: reportedRatio(ratio),
      });
    }
  }

  const report: BrandPaletteReport = {
    variant,
    pairs: evaluateContrastPairs(roles),
    adjustments,
    ctaNeedsBorder: contrastRatio(roles.cta, roles.background) < 3,
    harmony: scoreHarmony(roles),
  };

  return { seeds, roles, usage, report };
}

/** The four "Regenerate" alternatives, in their fixed cycling order. */
export function deriveBrandPaletteAlternatives(
  seeds: BrandSeeds,
  options: Omit<DeriveBrandPaletteOptions, 'variant'> = {},
): DerivedBrandPalette[] {
  return BRAND_PALETTE_VARIANTS.map((variant) =>
    deriveBrandPalette(seeds, { ...options, variant }),
  );
}

export interface BuildBrandPaletteInput {
  readonly seeds: BrandSeeds;
  readonly source: BrandPaletteSource;
  readonly status?: BrandPaletteStatus;
  readonly variant?: BrandPaletteVariant;
  readonly overrides?: BrandOverrides;
  readonly extraction?: BrandExtraction;
  readonly neutralChromaCap?: number;
  readonly fallbackAccent?: HslTriplet;
}

/** A complete, persistable palette (§D.2), `proposed` unless stated. */
export function buildBrandPalette(input: BuildBrandPaletteInput): BrandPalette {
  const overrides = input.overrides ?? {};
  const derived = deriveBrandPalette(input.seeds, {
    variant: input.variant,
    overrides,
    neutralChromaCap: input.neutralChromaCap,
    fallbackAccent: input.fallbackAccent,
  });
  return {
    schemaVersion: BRAND_PALETTE_SCHEMA_VERSION,
    algorithmVersion: BRAND_ENGINE_ALGORITHM_VERSION,
    status: input.status ?? 'proposed',
    source: input.source,
    // Seed overrides are the Owner's identity choice: stored as the seed.
    seeds: {
      ...input.seeds,
      ...Object.fromEntries(
        BRAND_SEED_NAMES.filter((name) => overrides[name]).map((name) => [
          name,
          overrides[name],
        ]),
      ),
    } as BrandSeeds,
    roles: derived.roles,
    usage: derived.usage,
    overrides: { ...overrides },
    report: derived.report,
    ...(input.extraction ? { extraction: input.extraction } : {}),
  };
}
