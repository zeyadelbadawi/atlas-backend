/**
 * W2 — the brand an owner chose in the academy setup form, carried by the
 * provisioning request itself (`provisioning_requests.requested_brand`) and
 * applied server-side by the orchestrator's `branding` step. Before this,
 * the palette and logo waited in browser memory and were saved by the page
 * after the fact — lost on refresh, tab close or network loss.
 *
 * What may be stored, and how it is validated (synchronously, at create):
 *
 *   - `palette` — the Brand Studio's palette INPUTS (seeds, overrides,
 *     variant, status, source, extraction). Every colour must be a hex
 *     colour (`#rgb`/`#rrggbb`) or Atlas's stored `"H S% L%"` triplet; hex
 *     is normalised to the triplet. The whole palette is then built and
 *     checked with the same engine and accessibility matrix the website
 *     Brand tab uses (`resolveBrandUpdate`), so an inaccessible palette is
 *     refused with 400 before the request exists, not discovered later.
 *   - `logo` — never bytes. A media asset can only exist once the Academy
 *     does, so the create call can only say a logo is coming
 *     (`logoPending: true` → `{ status: 'awaiting_upload' }`). The page then
 *     uploads it to the new Academy's media library and attaches it by
 *     media-asset id (`attachLogo`), which stores `{ status: 'attached',
 *     mediaAssetId, url }`.
 *   - Any `data:` URI anywhere in the payload is refused outright, and the
 *     object is strict: an unknown key (e.g. `logo: "data:…"`) is a 400.
 */
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { formatHslTriplet, isHslTriplet } from '../../website/brand-engine/color-space';
import {
  brandPaletteInputSchema,
  resolveBrandUpdate,
  type BrandPaletteInput,
} from '../../website/brand/brand-palette-update';
import { DEFAULT_BRAND_COLOR } from '../../website/constants/website.constants';

export type RequestedBrandLogo =
  | { readonly status: 'awaiting_upload' }
  | {
      readonly status: 'attached';
      readonly mediaAssetId: string;
      readonly url: string;
    };

export interface RequestedBrand {
  readonly palette?: BrandPaletteInput;
  readonly logo?: RequestedBrandLogo;
}

/** What the status endpoint says about the requested brand — never the palette itself. */
export interface RequestedBrandSummary {
  readonly palette: boolean;
  readonly logo: 'none' | 'awaiting_upload' | 'attached';
}

const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const DATA_URI = /^\s*data:/i;

/** `#rgb`/`#rrggbb` → `"H S% L%"`; a valid triplet unchanged; anything else `null`. */
export function normalizeBrandColor(value: string): string | null {
  const trimmed = value.trim();
  if (isHslTriplet(trimmed)) return trimmed;
  const match = HEX_COLOR.exec(trimmed);
  if (!match) return null;
  const digits =
    match[1].length === 3
      ? match[1]
          .split('')
          .map((c) => c + c)
          .join('')
      : match[1];
  const channel = (index: number) => parseInt(digits.slice(index, index + 2), 16) / 255;
  return formatHslTriplet({ r: channel(0), g: channel(2), b: channel(4) });
}

const color = z
  .string()
  .max(32, 'validation:invalidColor')
  .transform((value, ctx) => {
    const normalized = normalizeBrandColor(value);
    if (normalized === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'validation:invalidColor' });
      return z.NEVER;
    }
    return normalized;
  });

const incomingPaletteSchema = z
  .object({
    seeds: z
      .object({ primary: color, secondary: color.optional(), accent: color.optional() })
      .strict(),
    overrides: z.record(z.string().max(40), color).optional(),
    variant: z.string().max(40).optional(),
    status: z.string().max(20),
    source: z.string().max(20),
    extraction: z
      .object({
        logoFingerprint: z.string().max(64),
        candidates: z
          .array(
            z.object({ color, share: z.number(), class: z.string().max(20) }).strict(),
          )
          .max(8),
        flags: z.array(z.string().max(20)).max(6),
      })
      .strict()
      .optional(),
  })
  .strict();

const incomingBrandSchema = z
  .object({
    palette: incomingPaletteSchema.optional(),
    logoPending: z.boolean().optional(),
  })
  .strict();

function findDataUri(value: unknown, path: string[]): string | null {
  if (typeof value === 'string') return DATA_URI.test(value) ? path.join('.') : null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findDataUri(value[index], [...path, String(index)]);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const found = findDataUri(child, [...path, key]);
      if (found) return found;
    }
  }
  return null;
}

function invalid(field: string, messageKey: string): BadRequestException {
  return new BadRequestException({
    messageKey: 'errors.validation.failed',
    violations: [{ field, messageKey }],
  });
}

/**
 * Validates the create payload's `brand` and returns what to store, or
 * `null` when nothing was chosen (no palette, no logo). Throws 400 with
 * field violations otherwise. `userId` only feeds the palette build's
 * confirmation stamp, which is discarded here — the stored value is the
 * normalised INPUT, re-built authoritatively when the step applies it.
 */
export function parseRequestedBrand(raw: unknown, userId: string): RequestedBrand | null {
  if (raw === undefined || raw === null) return null;

  const dataUriAt = findDataUri(raw, ['brand']);
  if (dataUriAt) throw invalid(dataUriAt, 'errors.provisioning.brandDataUriRejected');

  const shape = incomingBrandSchema.safeParse(raw);
  if (!shape.success) {
    const issue = shape.error.issues[0];
    throw invalid(
      ['brand', ...issue.path].join('.'),
      issue.code === z.ZodIssueCode.unrecognized_keys
        ? 'errors.provisioning.brandUnknownField'
        : issue.message.startsWith('validation:')
          ? issue.message
          : 'validation:invalidFormat',
    );
  }

  let palette: BrandPaletteInput | undefined;
  if (shape.data.palette) {
    const parsed = brandPaletteInputSchema.safeParse(shape.data.palette);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw invalid(
        ['brand', 'palette', ...issue.path].join('.'),
        issue.message.startsWith('validation:')
          ? issue.message
          : 'validation:invalidFormat',
      );
    }
    palette = parsed.data;
    // Build and check it exactly as the Brand tab would — throws the same
    // 400 (with the same contrast violations) for an inaccessible palette.
    resolveBrandUpdate(
      {
        primaryColor: DEFAULT_BRAND_COLOR,
        secondaryColor: DEFAULT_BRAND_COLOR,
        accentColor: DEFAULT_BRAND_COLOR,
      },
      { palette },
      { userId, now: new Date() },
    );
  }

  const logo: RequestedBrandLogo | undefined = shape.data.logoPending
    ? { status: 'awaiting_upload' }
    : undefined;

  if (!palette && !logo) return null;
  return { ...(palette ? { palette } : {}), ...(logo ? { logo } : {}) };
}

/** Reads a stored `requested_brand` value defensively (it is JSON at rest). */
export function readRequestedBrand(stored: unknown): RequestedBrand | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const value = stored as Record<string, unknown>;
  const palette = brandPaletteInputSchema.safeParse(value.palette);
  const rawLogo = value.logo as Record<string, unknown> | undefined;
  let logo: RequestedBrandLogo | undefined;
  if (rawLogo?.status === 'awaiting_upload') logo = { status: 'awaiting_upload' };
  if (
    rawLogo?.status === 'attached' &&
    typeof rawLogo.mediaAssetId === 'string' &&
    typeof rawLogo.url === 'string' &&
    !DATA_URI.test(rawLogo.url)
  ) {
    logo = { status: 'attached', mediaAssetId: rawLogo.mediaAssetId, url: rawLogo.url };
  }
  if (!palette.success && !logo) return null;
  return {
    ...(palette.success ? { palette: palette.data } : {}),
    ...(logo ? { logo } : {}),
  };
}

export function summarizeRequestedBrand(
  stored: unknown,
): RequestedBrandSummary | undefined {
  const brand = readRequestedBrand(stored);
  if (!brand) return undefined;
  return { palette: !!brand.palette, logo: brand.logo?.status ?? 'none' };
}
