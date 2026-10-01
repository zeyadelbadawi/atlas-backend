/**
 * Brand engine — palette validation (Theme 1 plan §D.2, §F.4.3, §F.4.4).
 *
 * MIRRORED MODULE — see `color-space.ts`.
 *
 * What the backend enforces on every palette write, and what the Brand
 * Studio runs live: shape, formats, a known algorithm version, the full
 * contrast matrix, and the override rules. It never trusts the stored
 * report — it recomputes. Dependency-free on purpose (the same file runs in
 * the browser and in the API).
 *
 * Rules:
 *   - every §F.4.4 pair must pass — no exceptions, overrides included;
 *   - a failing pair that involves an Owner override names that override,
 *     with the nearest passing value as a suggestion;
 *   - the accent may fail 3:1 on the background only if `usage.accent` is
 *     `decorativeOnly` (and it is never allowed as text);
 *   - every override must match the value actually stored for that
 *     seed/role (a role override that isn't applied is a tampered write).
 */
import {
  contrastRatio,
  isHslTriplet,
  reportedRatio,
  tripletToOklch,
  type HslTriplet,
} from './color-space';
import { resolveColorRef, solveLightness } from './derive';
import {
  BRAND_CONTRAST_PAIRS,
  BRAND_PALETTE_SCHEMA_VERSION,
  BRAND_ROLE_NAMES,
  BRAND_SEED_NAMES,
  KNOWN_ALGORITHM_VERSIONS,
  type BrandColorRef,
  type BrandRoleName,
  type BrandRoles,
} from './palette.types';

export type BrandPaletteIssueCode =
  | 'invalidShape'
  | 'unsupportedSchemaVersion'
  | 'unknownAlgorithmVersion'
  | 'invalidColor'
  | 'contrastFailure'
  | 'decorativeUsageRequired'
  | 'unknownOverride'
  | 'overrideNotApplied';

export interface BrandPaletteIssue {
  /** JSON path into the palette, e.g. `roles.cta` or `overrides.link`. */
  readonly path: string;
  readonly code: BrandPaletteIssueCode;
  /** i18n key (`website` namespace) the UI and API error both use. */
  readonly messageKey: string;
  /** For contrast failures. */
  readonly pair?: {
    readonly fg: BrandColorRef;
    readonly bg: BrandColorRef;
    readonly ratio: number;
    readonly required: number;
  };
  /** The nearest passing value for the colour at `path`. */
  readonly suggestion?: HslTriplet;
}

export interface BrandPaletteValidationResult {
  readonly valid: boolean;
  readonly issues: readonly BrandPaletteIssue[];
}

const MESSAGE_PREFIX = 'website:brand.validation.';

function issue(
  path: string,
  code: BrandPaletteIssueCode,
  extra: Partial<BrandPaletteIssue> = {},
): BrandPaletteIssue {
  return { path, code, messageKey: `${MESSAGE_PREFIX}${code}`, ...extra };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const STATUSES = ['proposed', 'confirmed'];
const SOURCES = ['logo', 'manual', 'themeDefault'];
const USAGES = ['full', 'decorativeOnly'];
const SEED_OR_ROLE = new Set<string>([...BRAND_SEED_NAMES, ...BRAND_ROLE_NAMES]);

/** The nearest value for `ref` (a role) that makes the pair pass, holding the other side fixed. */
function suggestFor(
  roles: BrandRoles,
  ref: BrandRoleName,
  other: HslTriplet,
  required: number,
): HslTriplet | undefined {
  return (
    solveLightness(
      tripletToOklch(roles[ref]),
      (candidate) => contrastRatio(candidate, other) >= required,
    ) ?? undefined
  );
}

export function validateBrandPalette(value: unknown): BrandPaletteValidationResult {
  const issues: BrandPaletteIssue[] = [];
  if (!isRecord(value)) {
    return { valid: false, issues: [issue('', 'invalidShape')] };
  }

  if (value.schemaVersion !== BRAND_PALETTE_SCHEMA_VERSION) {
    issues.push(issue('schemaVersion', 'unsupportedSchemaVersion'));
  }
  if (
    typeof value.algorithmVersion !== 'string' ||
    !KNOWN_ALGORITHM_VERSIONS.includes(value.algorithmVersion)
  ) {
    issues.push(issue('algorithmVersion', 'unknownAlgorithmVersion'));
  }
  if (typeof value.status !== 'string' || !STATUSES.includes(value.status)) {
    issues.push(issue('status', 'invalidShape'));
  }
  if (typeof value.source !== 'string' || !SOURCES.includes(value.source)) {
    issues.push(issue('source', 'invalidShape'));
  }
  for (const key of ['confirmedAt', 'confirmedBy'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      issues.push(issue(key, 'invalidShape'));
    }
  }

  // Seeds: primary required, the others optional; all valid triplets.
  const seeds = value.seeds;
  if (!isRecord(seeds)) {
    issues.push(issue('seeds', 'invalidShape'));
  } else {
    for (const name of Object.keys(seeds)) {
      if (!(BRAND_SEED_NAMES as readonly string[]).includes(name)) {
        issues.push(issue(`seeds.${name}`, 'invalidShape'));
      }
    }
    for (const name of BRAND_SEED_NAMES) {
      const seed = seeds[name];
      if (seed === undefined && name !== 'primary') continue;
      if (!isHslTriplet(seed)) issues.push(issue(`seeds.${name}`, 'invalidColor'));
    }
  }

  // Roles: exactly the 19, all valid triplets.
  const rawRoles = value.roles;
  let roles: BrandRoles | null = null;
  if (!isRecord(rawRoles)) {
    issues.push(issue('roles', 'invalidShape'));
  } else {
    let rolesValid = true;
    for (const name of Object.keys(rawRoles)) {
      if (!(BRAND_ROLE_NAMES as readonly string[]).includes(name)) {
        issues.push(issue(`roles.${name}`, 'invalidShape'));
        rolesValid = false;
      }
    }
    for (const name of BRAND_ROLE_NAMES) {
      if (!isHslTriplet(rawRoles[name])) {
        issues.push(issue(`roles.${name}`, 'invalidColor'));
        rolesValid = false;
      }
    }
    if (rolesValid) roles = rawRoles as unknown as BrandRoles;
  }

  const usage = value.usage;
  if (!isRecord(usage)) {
    issues.push(issue('usage', 'invalidShape'));
  } else {
    for (const [name, entry] of Object.entries(usage)) {
      if (
        !(BRAND_SEED_NAMES as readonly string[]).includes(name) ||
        typeof entry !== 'string' ||
        !USAGES.includes(entry)
      ) {
        issues.push(issue(`usage.${name}`, 'invalidShape'));
      }
    }
  }

  const overrides = value.overrides;
  if (!isRecord(overrides)) {
    issues.push(issue('overrides', 'invalidShape'));
  } else {
    for (const [name, override] of Object.entries(overrides)) {
      if (!SEED_OR_ROLE.has(name)) {
        issues.push(issue(`overrides.${name}`, 'unknownOverride'));
      } else if (!isHslTriplet(override)) {
        issues.push(issue(`overrides.${name}`, 'invalidColor'));
      }
    }
  }

  if (!isRecord(value.report)) issues.push(issue('report', 'invalidShape'));
  if (value.extraction !== undefined && !isRecord(value.extraction)) {
    issues.push(issue('extraction', 'invalidShape'));
  }

  // Formats first: the contrast matrix needs every colour to parse.
  if (!roles || issues.length > 0) return { valid: false, issues };

  const overrideMap = overrides as Record<string, HslTriplet>;
  const seedMap = seeds as Record<string, HslTriplet>;
  for (const [name, override] of Object.entries(overrideMap)) {
    // `primary`/`secondary`/`accent` overrides are seed overrides (their
    // roles are derived from them); every other name is a role override.
    const stored = (BRAND_SEED_NAMES as readonly string[]).includes(name)
      ? seedMap[name]
      : roles[name as BrandRoleName];
    // A seed override only has to match when that seed is stored at all.
    if (stored !== undefined && stored !== override) {
      issues.push(issue(`overrides.${name}`, 'overrideNotApplied'));
    }
  }

  for (const pair of BRAND_CONTRAST_PAIRS) {
    const fg = resolveColorRef(roles, pair.fg);
    const bg = resolveColorRef(roles, pair.bg);
    const ratio = contrastRatio(fg, bg);
    if (ratio >= pair.required) continue;
    // Name the side the Owner chose, if either; otherwise the foreground.
    const fgRole = pair.fg === 'ctaHover' || pair.fg === 'ctaPressed' ? 'cta' : pair.fg;
    const bgRole = pair.bg === 'ctaHover' || pair.bg === 'ctaPressed' ? 'cta' : pair.bg;
    const isRoleOverride = (role: BrandRoleName) =>
      !(BRAND_SEED_NAMES as readonly string[]).includes(role) &&
      overrideMap[role] !== undefined;
    const blamed: BrandRoleName =
      isRoleOverride(bgRole) && !isRoleOverride(fgRole) ? bgRole : fgRole;
    const other = blamed === fgRole ? bg : fg;
    const inOverride = isRoleOverride(blamed);
    issues.push(
      issue(`${inOverride ? 'overrides' : 'roles'}.${blamed}`, 'contrastFailure', {
        pair: {
          fg: pair.fg,
          bg: pair.bg,
          ratio: reportedRatio(ratio),
          required: pair.required,
        },
        // A hover/pressed pair is fixed by moving `cta` itself, and its
        // states move with it — not expressible against one fixed colour.
        suggestion:
          pair.bg === 'ctaHover' || pair.bg === 'ctaPressed'
            ? undefined
            : suggestFor(roles, blamed, other, pair.required),
      }),
    );
  }

  // The accent may fail 3:1 on the background only as decoration.
  const accentRatio = contrastRatio(roles.accent, roles.background);
  if (accentRatio < 3 && isRecord(usage) && usage.accent !== 'decorativeOnly') {
    issues.push(issue('usage.accent', 'decorativeUsageRequired'));
  }

  return { valid: issues.length === 0, issues };
}
