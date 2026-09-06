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
