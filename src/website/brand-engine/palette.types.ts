/**
 * Brand engine — palette shape and the accessibility contract (Theme 1 plan
 * §D.2, §F.4.4).
 *
 * MIRRORED MODULE — see `color-space.ts`.
 *
 * A Brand Palette is theme-independent: seeds (brand identity inputs, never
 * UI colours) plus derived, validated semantic roles. Each theme maps the
 * roles to its own CSS variables (`mapBrandPalette`, §F.5).
 */
import type { HslTriplet } from './color-space';

export const BRAND_PALETTE_SCHEMA_VERSION = 1;

/** Bump on ANY change to derivation output; stored palettes keep theirs (§F.4.6). */
export const BRAND_ENGINE_ALGORITHM_VERSION = 'bp-1';
export const KNOWN_ALGORITHM_VERSIONS: readonly string[] = [
  BRAND_ENGINE_ALGORITHM_VERSION,
];

export const BRAND_SEED_NAMES = ['primary', 'secondary', 'accent'] as const;
export type BrandSeedName = (typeof BRAND_SEED_NAMES)[number];

export const BRAND_ROLE_NAMES = [
  'primary',
  'primaryForeground',
  'secondary',
  'secondaryForeground',
  'accent',
  'accentForeground',
  'background',
  'surface',
  'surfaceMuted',
  'foreground',
  'foregroundMuted',
  'border',
  'success',
  'warning',
  'error',
  'focus',
  'link',
  'cta',
  'ctaForeground',
] as const;
export type BrandRoleName = (typeof BRAND_ROLE_NAMES)[number];

/** Interaction states derived from `cta` (`deriveInteractionStates`); validated, never stored. */
export type BrandStateName = 'ctaHover' | 'ctaPressed';

export type BrandColorRef = BrandRoleName | BrandStateName;

/** `primary` is required; a logo with one colour, or a manual pick, may give only that. */
export interface BrandSeeds {
  readonly primary: HslTriplet;
  readonly secondary?: HslTriplet;
  readonly accent?: HslTriplet;
}

export type BrandRoles = Readonly<Record<BrandRoleName, HslTriplet>>;

export type SeedUsage = 'full' | 'decorativeOnly';

/**
 * The four deterministic alternatives "Regenerate" cycles (§F.4.2), in
 * order. `balanced` is the default.
 */
export const BRAND_PALETTE_VARIANTS = [
  'balanced',
  'vivid',
  'calm',
  'secondaryLed',
] as const;
export type BrandPaletteVariant = (typeof BRAND_PALETTE_VARIANTS)[number];

/**
 * Owner choices: authoritative over derivation (§F.4.6). `primary`,
 * `secondary` and `accent` name both a seed and a role; for those three an
 * override is always a SEED override (dependent roles re-derive, §F.4.5).
 * Every other key overrides that role directly ("Advanced").
 */
export type BrandOverrides = Partial<
  Readonly<Record<BrandSeedName | BrandRoleName, HslTriplet>>
>;

/** What a pair is, and why it matters — mirrored in the Brand Studio badges. */
export type ContrastPairKind = 'text' | 'nonText';

export interface ContrastPairSpec {
  readonly fg: BrandColorRef;
  readonly bg: BrandColorRef;
  readonly required: number;
  readonly kind: ContrastPairKind;
}

/**
 * §F.4.4 — every pair a persisted palette must pass. The engine may adjust
 * a colour to meet a pair; it may never lower a threshold.
 *
 * Deliberately NOT here: `accent` against `background` (3:1). Failing it
 * doesn't reject a palette — it demotes the accent to `decorativeOnly`
 * (shapes, glows, dots; never text or a sole indicator). `cta` against
 * `background` (3:1) likewise doesn't reject: the report asks the theme to
 * draw a 1px `foreground` border (`ctaNeedsBorder`). Theme-specific pairs
 * (e.g. Theme 1's ink band) are checked by that theme's mapping tests.
 */
export const BRAND_CONTRAST_PAIRS: readonly ContrastPairSpec[] = [
  { fg: 'foreground', bg: 'background', required: 7, kind: 'text' },
  { fg: 'foreground', bg: 'surface', required: 7, kind: 'text' },
  { fg: 'foregroundMuted', bg: 'background', required: 4.5, kind: 'text' },
  { fg: 'foregroundMuted', bg: 'surface', required: 4.5, kind: 'text' },
  { fg: 'foregroundMuted', bg: 'surfaceMuted', required: 4.5, kind: 'text' },
  { fg: 'ctaForeground', bg: 'cta', required: 4.5, kind: 'text' },
  { fg: 'ctaForeground', bg: 'ctaHover', required: 4.5, kind: 'text' },
  { fg: 'ctaForeground', bg: 'ctaPressed', required: 4.5, kind: 'text' },
  { fg: 'primaryForeground', bg: 'primary', required: 4.5, kind: 'text' },
  { fg: 'secondaryForeground', bg: 'secondary', required: 4.5, kind: 'text' },
  { fg: 'accentForeground', bg: 'accent', required: 4.5, kind: 'text' },
  { fg: 'link', bg: 'background', required: 4.5, kind: 'text' },
  { fg: 'link', bg: 'surface', required: 4.5, kind: 'text' },
  { fg: 'focus', bg: 'background', required: 3, kind: 'nonText' },
  { fg: 'focus', bg: 'surface', required: 3, kind: 'nonText' },
  { fg: 'border', bg: 'background', required: 3, kind: 'nonText' },
  { fg: 'success', bg: 'background', required: 4.5, kind: 'text' },
  { fg: 'success', bg: 'surface', required: 4.5, kind: 'text' },
  { fg: 'warning', bg: 'background', required: 4.5, kind: 'text' },
  { fg: 'warning', bg: 'surface', required: 4.5, kind: 'text' },
  { fg: 'error', bg: 'background', required: 4.5, kind: 'text' },
  { fg: 'error', bg: 'surface', required: 4.5, kind: 'text' },
];

export interface ContrastPairResult {
  readonly fg: BrandColorRef;
  readonly bg: BrandColorRef;
  readonly ratio: number;
  readonly required: number;
  readonly pass: boolean;
}

export type PaletteAdjustmentReason =
  /** Lightness moved so a pair passes. */
  | 'contrast'
  /** Seed kept as-is but only for decoration (fails 3:1 on the background). */
  | 'decorativeOnly'
  /** No such seed in the input; derived by harmony from the primary. */
  | 'harmonyFill'
  /** A status colour moved away from a brand hue it collided with. */
  | 'statusHueCollision';

/** One human-readable adjustment, rendered by the Brand Studio (i18n by `reason`). */
export interface PaletteAdjustment {
  readonly target: BrandSeedName | BrandRoleName;
  readonly reason: PaletteAdjustmentReason;
  readonly from?: HslTriplet;
  readonly to?: HslTriplet;
  /** For `decorativeOnly`: the seed's ratio on the background. */
  readonly ratio?: number;
}

export interface BrandPaletteReport {
  readonly variant: BrandPaletteVariant;
  readonly pairs: readonly ContrastPairResult[];
  readonly adjustments: readonly PaletteAdjustment[];
  /** `cta` is under 3:1 on `background`; themes add a 1px `foreground` border. */
  readonly ctaNeedsBorder: boolean;
  /** Harmony (reporting/ranking only, §F.4.2 step 8). */
  readonly harmony: {
    readonly score: number;
    /** Role pairs closer than ΔE_ok 0.08 (hard to tell apart, e.g. for colour-blind visitors). */
    readonly indistinguishable: readonly (readonly [BrandRoleName, BrandRoleName])[];
  };
}

export type BrandPaletteStatus = 'proposed' | 'confirmed';
export type BrandPaletteSource = 'logo' | 'manual' | 'themeDefault';

export interface BrandExtraction {
  /** sha256 of the logo bytes — how a later logo change is detected. */
  readonly logoFingerprint: string;
  readonly candidates: readonly BrandCandidate[];
  readonly flags: readonly BrandExtractionFlag[];
}

export type BrandCandidateClass = 'chromatic' | 'neutral' | 'dark' | 'light';

export interface BrandCandidate {
  readonly color: HslTriplet;
  /** Share of the logo's (masked) pixels, 0..1, 3 decimals. */
  readonly share: number;
  readonly class: BrandCandidateClass;
}

export type BrandExtractionFlag =
  'empty' | 'monochrome' | 'lowChroma' | 'noisyBackground' | 'singleHue' | 'neonSeed';

/** The persisted shape: `WebsiteConfiguration.brand.palette` (§D.2). */
export interface BrandPalette {
  readonly schemaVersion: typeof BRAND_PALETTE_SCHEMA_VERSION;
  readonly algorithmVersion: string;
  readonly status: BrandPaletteStatus;
  readonly source: BrandPaletteSource;
  readonly seeds: BrandSeeds;
  readonly roles: BrandRoles;
  readonly usage: Readonly<Partial<Record<BrandSeedName, SeedUsage>>>;
  readonly overrides: BrandOverrides;
  readonly report: BrandPaletteReport;
  readonly extraction?: BrandExtraction;
  readonly confirmedAt?: string;
  readonly confirmedBy?: string;
}
