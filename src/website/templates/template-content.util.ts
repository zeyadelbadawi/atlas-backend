/**
 * Shared helpers every theme template + `WebsiteGenerationService` uses.
 *
 * `interpolate` is the ONE place `{{academyName}}`/`{{academyDescription}}`
 * tokens are resolved — the only two pieces of real Academy data safe to
 * weave into generated copy at generation time (both already collected in
 * "Basics," before generation ever runs). Nothing else is ever
 * interpolated — a course count, an instructor name, a student number
 * would all be fabrication if baked into static copy instead of left to
 * the dynamic section types that resolve them live (see
 * `WebsiteGenerationService`'s own doc comment).
 */
import type { LocalizedTextLike } from '../utils/localized-text.util';

export interface TemplateInterpolationContext {
  readonly academyName: string;
  readonly academyDescription?: string;
}

export function interpolate(text: string, context: TemplateInterpolationContext): string {
  return text
    .replace(/\{\{academyName\}\}/g, context.academyName)
    .replace(/\{\{academyDescription\}\}/g, context.academyDescription ?? '');
}

export function interpolateLocalized(
  value: LocalizedTextLike,
  context: TemplateInterpolationContext,
): LocalizedTextLike {
  return { en: interpolate(value.en, context), ar: interpolate(value.ar, context) };
}

/** `en`-only shorthand — most generated copy has a real Arabic counterpart authored alongside it, but a handful of tokens (an interpolated-only title) have no separate Arabic string to write; `ar` degrades to `en` at render time regardless (`resolveLocalizedText`), so leaving it blank here is honest, not a shortcut. */
export function lt(en: string, ar: string = ''): LocalizedTextLike {
  return { en, ar };
}

const ACADEMY_NAME_TOKEN = '{{academyName}}';
/** Below this many characters a shortened name stops reading as the name, so the whole sentence is shortened instead. */
const MIN_FITTED_NAME_LENGTH = 12;

/** Shortens `text` to at most `max` characters, at a word boundary when one is close, marking the cut with an ellipsis. */
export function shortenToLength(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max - 1));
  const lastSpace = cut.lastIndexOf(' ');
  const atWord = lastSpace >= max / 2 ? cut.slice(0, lastSpace) : cut;
  return `${atWord.trimEnd()}…`;
}

/**
 * Interpolates `text` so the result fits a content limit
 * (`website.constants.ts`). Template copy is written inside the limits,
 * but `{{academyName}}` can be up to `MAX_ACADEMY_NAME_LENGTH` (100)
 * characters, which would push e.g. "{{academyName}} — a learning studio"
 * past the 70-character hero title. The name is shortened first (the rest
 * of the sentence is the template's own copy); only when too little room
 * would be left for it is the whole sentence shortened. Generated copy is
 * starter content the Owner edits — a generated page must never fail the
 * write validation, and provisioning must never fail on a long name.
 */
export function interpolateWithin(
  text: string,
  context: TemplateInterpolationContext,
  max: number,
): string {
  const full = interpolate(text, context);
  if (full.length <= max) return full;
  const occurrences = text.split(ACADEMY_NAME_TOKEN).length - 1;
  if (occurrences > 0) {
    const rest = interpolate(text.split(ACADEMY_NAME_TOKEN).join(''), context).length;
    const room = Math.floor((max - rest) / occurrences);
    if (room >= MIN_FITTED_NAME_LENGTH) {
      return interpolate(text, {
        ...context,
        academyName: shortenToLength(context.academyName, room),
      });
    }
  }
  return shortenToLength(full, max);
}
