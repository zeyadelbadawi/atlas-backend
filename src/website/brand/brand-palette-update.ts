/**
 * Brand palette persistence (Theme 1 plan §D.2, §F.4.3, §F.4.6) — the
 * backend's authority over `WebsiteConfiguration.brand.palette`.
 *
 * The palette lives inside the existing `brand` JSON column: no schema
 * migration. The browser proposes; this module decides:
 *
 *   - A client sends the palette's INPUTS (seeds, overrides, alternative,
 *     status, source, extraction). Every role is re-derived HERE with the
 *     shared engine and the result validated against the full §F.4.4
 *     matrix; roles, usage or report sent by a client are ignored, so a
 *     modified client can't store an inaccessible palette.
 *   - `confirmedAt`/`confirmedBy` come from the server clock and the
 *     authenticated user, never from the request.
 *   - The legacy `primaryColor`/`secondaryColor`/`accentColor` are written
 *     equal to the (resolved) seeds on every palette save, so Themes 2–5 and
 *     older clients keep working unchanged (§F.4.6).
 *   - The other direction too: an older client (today's Brand tab) that
 *     changes a legacy colour while a palette exists re-derives the palette
 *     from the new colours, keeping the Owner's role overrides — the two can
 *     never disagree. If that makes an override fail, the save is refused
 *     with the same violations as any palette write.
 *   - `palette: null` removes it (back to the theme's defaults).
 */
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { HSL_TRIPLET_REGEX } from '../constants/website.constants';
import type { FieldViolation } from '../../common/dto/api-error.dto';
import { buildBrandPalette, deriveBrandPalette } from '../brand-engine/derive';
import { validateBrandPalette } from '../brand-engine/validate';
import {
  BRAND_PALETTE_VARIANTS,
  BRAND_ROLE_NAMES,
  BRAND_SEED_NAMES,
  type BrandOverrides,
  type BrandPalette,
  type BrandPaletteVariant,
} from '../brand-engine/palette.types';

const hsl = z.string().regex(HSL_TRIPLET_REGEX, 'validation:invalidColor');

/** What a client may send. Anything else in the object (roles, report…) is dropped. */
export const brandPaletteInputSchema = z.object({
  seeds: z
    .object({ primary: hsl, secondary: hsl.optional(), accent: hsl.optional() })
    .strict(),
  overrides: z.record(z.enum([...BRAND_SEED_NAMES, ...BRAND_ROLE_NAMES]), hsl).optional(),
  variant: z.enum(BRAND_PALETTE_VARIANTS).optional(),
  status: z.enum(['proposed', 'confirmed']),
  source: z.enum(['logo', 'manual', 'themeDefault']),
  extraction: z
    .object({
      logoFingerprint: z.string().regex(/^[a-f0-9]{64}$/, 'validation:invalidFormat'),
      candidates: z
        .array(
          z.object({
            color: hsl,
            share: z.number().min(0).max(1),
            class: z.enum(['chromatic', 'neutral', 'dark', 'light']),
          }),
        )
        .max(8),
      flags: z
        .array(
          z.enum([
            'empty',
            'monochrome',
            'lowChroma',
            'noisyBackground',
            'singleHue',
            'neonSeed',
          ]),
        )
        .max(6),
    })
    .optional(),
});
export type BrandPaletteInput = z.infer<typeof brandPaletteInputSchema>;

interface LegacyBrand {
  readonly primaryColor?: string;
  readonly secondaryColor?: string;
  readonly accentColor?: string;
}

function rejectInvalid(palette: BrandPalette): void {
  const result = validateBrandPalette(palette);
  if (result.valid) return;
  const violations: FieldViolation[] = result.issues.map((issue) => ({
    field: `brand.palette.${issue.path}`,
    messageKey: issue.messageKey,
    ...(issue.pair || issue.suggestion
      ? {
          values: {
            ...(issue.pair
              ? {
                  fg: issue.pair.fg,
                  bg: issue.pair.bg,
                  ratio: issue.pair.ratio,
                  required: issue.pair.required,
                }
              : {}),
            ...(issue.suggestion ? { suggestion: issue.suggestion } : {}),
          },
        }
      : {}),
  }));
  throw new BadRequestException({ messageKey: 'errors.validation.failed', violations });
}

/** Role overrides only — seed overrides are replaced when the seeds are. */
function roleOverrides(overrides: BrandOverrides): BrandOverrides {
  return Object.fromEntries(
    Object.entries(overrides).filter(
      ([name]) => !(BRAND_SEED_NAMES as readonly string[]).includes(name),
    ),
  );
}

function buildAuthoritative(
  input: {
    readonly seeds: BrandPalette['seeds'];
    readonly overrides?: BrandOverrides;
    readonly variant?: BrandPaletteVariant;
    readonly status: BrandPalette['status'];
    readonly source: BrandPalette['source'];
    readonly extraction?: BrandPalette['extraction'];
  },
  actor: { readonly userId: string; readonly now: Date },
  previous: BrandPalette | undefined,
): BrandPalette {
  const built = buildBrandPalette({
    seeds: input.seeds,
    source: input.source,
    status: input.status,
    variant: input.variant,
    overrides: input.overrides ?? {},
    extraction: input.extraction,
  });
  rejectInvalid(built);
  if (built.status !== 'confirmed') return built;
  // Keep the original confirmation when a confirmed palette is only re-saved.
  const keepConfirmation =
    previous?.status === 'confirmed' &&
    JSON.stringify(previous.roles) === JSON.stringify(built.roles) &&
    previous.confirmedAt !== undefined;
  return {
    ...built,
    confirmedAt: keepConfirmation ? previous.confirmedAt : actor.now.toISOString(),
    confirmedBy: keepConfirmation ? previous.confirmedBy : actor.userId,
  };
}

function legacyFromPalette(palette: BrandPalette): Required<LegacyBrand> {
  // The resolved seeds (harmony fills included), so every legacy field is set.
  const { seeds } = deriveBrandPalette(palette.seeds, { overrides: palette.overrides });
  return {
    primaryColor: seeds.primary,
    secondaryColor: seeds.secondary,
    accentColor: seeds.accent,
  };
}

/**
 * The next stored `brand` object for a PATCH. `current` is what's stored;
 * `patch` is the already-shape-validated partial update (its `palette` key,
 * if present, is unparsed).
 */
export function resolveBrandUpdate(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
  actor: { readonly userId: string; readonly now: Date },
): Record<string, unknown> {
  const { palette: rawPalette, ...legacyPatch } = patch;
  const previous = current.palette as BrandPalette | undefined;
  const next: Record<string, unknown> = { ...current, ...legacyPatch };

  if (rawPalette === null) {
    delete next.palette;
    return next;
  }

  if (rawPalette !== undefined) {
    const parsed = brandPaletteInputSchema.safeParse(rawPalette);
    if (!parsed.success) {
      throw new BadRequestException({
        messageKey: 'errors.validation.failed',
        violations: parsed.error.issues.map((issue) => ({
          field: ['brand', 'palette', ...issue.path].join('.'),
          messageKey: issue.message,
        })),
      });
    }
    const palette = buildAuthoritative(parsed.data, actor, previous);
    return { ...next, palette, ...legacyFromPalette(palette) };
  }

  // A legacy-only change while a palette exists: re-derive the palette from
  // the new colours so the two never disagree (§F.4.6 "legacy = seeds").
  const legacyChanged = (['primaryColor', 'secondaryColor', 'accentColor'] as const).some(
    (key) => legacyPatch[key] !== undefined && legacyPatch[key] !== current[key],
  );
  if (previous && legacyChanged) {
    const palette = buildAuthoritative(
      {
        seeds: {
          primary: next.primaryColor as string,
          secondary: next.secondaryColor as string,
          accent: next.accentColor as string,
        },
        overrides: roleOverrides(previous.overrides ?? {}),
        variant: previous.report?.variant,
        status: previous.status,
        source: 'manual',
        extraction: previous.extraction,
      },
      actor,
      previous,
    );
    return { ...next, palette };
  }

  return next;
}

/** What the PUBLIC configuration may carry: no confirmer, no confirmation time, no logo analysis. */
export function toPublicBrand(brand: Record<string, unknown>): Record<string, unknown> {
  const palette = brand.palette as BrandPalette | undefined;
  if (!palette) return brand;
  const publicPalette: Record<string, unknown> = { ...palette };
  delete publicPalette.confirmedBy;
  delete publicPalette.confirmedAt;
  delete publicPalette.extraction;
  return { ...brand, palette: publicPalette };
}
