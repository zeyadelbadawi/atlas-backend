/**
 * The plan name an email shows, in the recipient's language.
 *
 * Senders put both forms in the outbox values: `planName` (the English
 * catalog name, the fallback every template already reads) and
 * `planNameLocalized` (the catalog's `{ en, ar }` text). The renderer then
 * swaps `planName` for the recipient's locale (`resolveLocalizedPlanName`),
 * so an Arabic owner reads "الأكاديمية", not "Academy", in every template
 * without each template knowing about it.
 */
import type { CommunicationLocale } from '../catalog/communication-catalog';

export interface PlanNameSource {
  readonly name: string;
  readonly nameLocalized?: unknown;
}

export function planNameValues(plan: PlanNameSource | null | undefined): {
  planName: string;
  planNameLocalized?: { en?: string; ar?: string };
} {
  if (!plan) return { planName: '' };
  const localized = pickLocalized(plan.nameLocalized);
  return localized
    ? { planName: plan.name, planNameLocalized: localized }
    : { planName: plan.name };
}

export function resolveLocalizedPlanName<T extends Record<string, unknown>>(
  values: T,
  locale: CommunicationLocale,
): T {
  const localized = pickLocalized(values.planNameLocalized);
  const name = localized?.[locale];
  return name ? { ...values, planName: name } : values;
}

function pickLocalized(value: unknown): { en?: string; ar?: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const out: { en?: string; ar?: string } = {};
  for (const locale of ['en', 'ar'] as const) {
    const text = source[locale];
    if (typeof text === 'string' && text.trim() !== '') out[locale] = text.trim();
  }
  return out.en || out.ar ? out : undefined;
}
