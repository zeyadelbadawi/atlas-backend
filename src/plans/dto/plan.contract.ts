/**
 * `Plan` response contract — matches `Plan` (`plan.types.ts`) field-for-
 * field. `limits`/`features`/`pricing` are stored as JSONB and validated
 * server-side at write time (there is no write endpoint for `plans` in
 * P4 — the catalog is seeded directly, mirroring how P2 seeds test
 * organizations — so today validation matters only for internal
 * consistency, not an inbound request), never schema-enforced, matching
 * `users.preferences`'s established precedent in this codebase.
 */
import type { Plan as PrismaPlan } from '@prisma/client';
import type { PlanFeatures, PlanResourceLimits } from './entitlement.types';

export interface PlanPricingMetadataResponse {
  readonly amount?: number;
  readonly currency?: string;
  readonly billingCycle?: 'monthly' | 'yearly';
}

/**
 * P54 — the `{ en, ar }` shape every other piece of bilingual business
 * content in Atlas already uses (website CMS entries, inline section
 * content, SEO fields). Structurally identical to the website module's
 * `LocalizedTextResponse` and to the frontend's `LocalizedText`, which is
 * the point: the frontend resolves a plan's name with the SAME
 * `resolveLocalizedText` helper it already uses everywhere else.
 */
export interface PlanLocalizedTextResponse {
  readonly en: string;
  readonly ar: string;
}

/**
 * Reads a `{ en, ar }` JSONB column defensively.
 *
 * `plans.nameLocalized` is `Json?` — validated server-side rather than
 * schema-enforced, matching `limits`/`features`/`pricing`'s own precedent
 * on this model. A row that predates P54, or one seeded without
 * translations, is `null`; a row holding something that is not the
 * expected shape must not crash a catalog read for every customer. Both
 * cases resolve to `undefined`, and the caller falls back to the plain
 * `name`/`description` string — which is exactly what the frontend's
 * `resolveLocalizedText(value: LocalizedText | string)` already handles.
 */
function toLocalizedText(value: unknown): PlanLocalizedTextResponse | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.en !== 'string' || typeof candidate.ar !== 'string') {
    return undefined;
  }
  // A blank Arabic side is not a translation. Treating it as one would
  // render an empty plan name in Arabic; falling back shows English, which
  // is honest and legible.
  if (candidate.ar.trim().length === 0) return undefined;
  return { en: candidate.en, ar: candidate.ar };
}

export interface PlanResponse {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  /**
   * P54 — bilingual catalog text. ADDITIVE: `name`/`description` above are
   * unchanged and remain authoritative for English and for every
   * non-UI reader (audit-log labels, admin views, checkout). Absent when a
   * plan has no translations, in which case the client falls back to
   * `name`/`description`.
   */
  readonly nameLocalized?: PlanLocalizedTextResponse;
  readonly descriptionLocalized?: PlanLocalizedTextResponse;
  readonly status: PrismaPlan['status'];
  readonly displayOrder: number;
  readonly limits: PlanResourceLimits;
  readonly features: PlanFeatures;
  readonly pricing?: PlanPricingMetadataResponse;
  /**
   * Phase 11 — whether this plan may be taken as a Free Trial.
   *
   * FOR DISPLAY ONLY. The frontend uses it to decide whether to render a
   * "Try free" CTA instead of "Select this plan"; it is never the control.
   * `TrialRedemptionService.startTrial` re-reads the same column and
   * refuses regardless of what any client believed.
   */
  readonly trialEligible: boolean;
  /** Days this plan's trial runs, resolved against the platform default. Absent when the plan is not trialable. */
  readonly trialDurationDays?: number;
  /**
   * P57 — optimistic-concurrency token. Exposed so the Platform-Owner plan
   * editor can send it back as `expectedVersion`; a customer-facing client
   * simply ignores it, exactly as it ignores `add_ons.version` today.
   */
  readonly version: number;
}

export function toPlanResponse(
  plan: PrismaPlan,
  /**
   * The platform-wide default, used when a plan does not override it.
   * Passed in rather than read here so this stays a pure mapper, and so
   * the caller makes exactly one policy read for a whole catalog page
   * instead of one per plan.
   */
  defaultTrialDurationDays?: number,
): PlanResponse {
  const trialDurationDays = plan.trialEligible
    ? (plan.trialDurationDays ?? defaultTrialDurationDays)
    : undefined;

  return {
    id: plan.id,
    key: plan.key,
    name: plan.name,
    description: plan.description ?? undefined,
    nameLocalized: toLocalizedText(plan.nameLocalized),
    descriptionLocalized: toLocalizedText(plan.descriptionLocalized),
    status: plan.status,
    displayOrder: plan.displayOrder,
    limits: plan.limits as unknown as PlanResourceLimits,
    features: plan.features as unknown as PlanFeatures,
    pricing: (plan.pricing as PlanPricingMetadataResponse | null) ?? undefined,
    trialEligible: plan.trialEligible,
    version: plan.version,
    ...(trialDurationDays === undefined ? {} : { trialDurationDays }),
  };
}
