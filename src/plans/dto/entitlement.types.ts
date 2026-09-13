/**
 * Entitlement domain types — backend mirror of `plan.types.ts`/
 * `tenant.types.ts` (atlas frontend). These are the wire/computation
 * contracts `EntitlementService` and every Plan/Add-on/Usage response DTO
 * share; kept in one file since they're mutually referential, matching
 * how the frontend keeps them in one file too.
 */

/** A resource limit value. Explicit `'unlimited'` — never a magic number. */
export type LimitValue = number | 'unlimited';

/** Matches `PlanLimitKey` (`plan.types.ts`) exactly — 8 keys. */
export type PlanLimitKey =
  | 'academies'
  | 'students'
  | 'instructors'
  | 'staff'
  | 'courses'
  | 'generalStorage'
  | 'videoStorage'
  /**
   * Live Sessions add-on — how many sessions may be RECORDED.
   *
   * Counts recorded SESSIONS, not recording files: one session whose
   * provider produces three files still consumes exactly one. Normal
   * (unrecorded) live sessions are NOT governed by this limit at all —
   * they are gated by the `liveSessions` feature instead.
   *
   * The keys already existed as untyped JSON on every seeded plan before
   * this phase; formalising them here is what finally gives that data
   * meaning, rather than adding a parallel counter.
   */
  | 'recordedSessions';

/** Every `PlanLimitKey`, for iteration — mirrors `PLAN_LIMIT_KEYS` (`tenant.constants.ts`). Order doesn't matter here (unlike the frontend's display-order constant); this is used for exhaustive validation/iteration only. */
export const PLAN_LIMIT_KEYS: readonly PlanLimitKey[] = [
  'academies',
  'students',
  'instructors',
  'staff',
  'courses',
  'generalStorage',
  'videoStorage',
  'recordedSessions',
];

/** Matches `PlanResourceLimits` (`plan.types.ts`) exactly. */
export interface PlanResourceLimits {
  readonly academies: LimitValue;
  readonly students: LimitValue;
  readonly instructors: LimitValue;
  readonly staff: LimitValue;
  readonly courses: LimitValue;
  readonly generalStorage: LimitValue;
  readonly videoStorage: LimitValue;
  readonly recordedSessions: LimitValue;
}

/** Matches `PlanFeatureKey` (`plan.types.ts`) exactly — 12 keys. */
export type PlanFeatureKey =
  | 'cms'
  | 'seo'
  | 'seoAdvanced'
  | 'marketing'
  | 'marketingAdvanced'
  | 'analytics'
  | 'analyticsAdvanced'
  | 'customDomain'
  | 'themes'
  | 'multipleThemes'
  | 'backup'
  /**
   * Whether this tenant may run Live Sessions at all.
   *
   * Normally granted by ACTIVATING the Live Sessions add-on (whose effect
   * is `{type:'feature', featureKey:'liveSessions'}`) rather than by the
   * base plan, which is precisely what the existing add-on effect model
   * was built for — a plan may still grant it directly if a future tier
   * bundles it.
   */
  | 'liveSessions';

/** Every `PlanFeatureKey`, for iteration — mirrors `PLAN_FEATURE_KEYS` (`tenant.constants.ts`). */
export const PLAN_FEATURE_KEYS: readonly PlanFeatureKey[] = [
  'cms',
  'seo',
  'seoAdvanced',
  'marketing',
  'marketingAdvanced',
  'analytics',
  'analyticsAdvanced',
  'customDomain',
  'themes',
  'multipleThemes',
  'backup',
  'liveSessions',
];

/** Matches `PlanFeatures` (`plan.types.ts`) exactly. */
export interface PlanFeatures {
  readonly cms: boolean;
  readonly seo: boolean;
  readonly seoAdvanced: boolean;
  readonly marketing: boolean;
  readonly marketingAdvanced: boolean;
  readonly analytics: boolean;
  readonly analyticsAdvanced: boolean;
  readonly customDomain: boolean;
  readonly themes: boolean;
  readonly multipleThemes: boolean;
  readonly backup: boolean;
  readonly liveSessions: boolean;
}

/** Matches `AddOnLimitEffect`/`AddOnFeatureEffect`/`AddOnEffect` (`plan.types.ts`) exactly. */
export interface AddOnLimitEffect {
  readonly type: 'limit';
  readonly limitKey: PlanLimitKey;
  readonly amount: number;
}

export interface AddOnFeatureEffect {
  readonly type: 'feature';
  readonly featureKey: PlanFeatureKey;
}

export type AddOnEffect = AddOnLimitEffect | AddOnFeatureEffect;

/** Minimal shape `EntitlementService` needs from a Plan/AddOn — decoupled from the Prisma model or response DTO so the pure computation functions stay easy to unit test. */
export interface EntitlementPlanInput {
  readonly key: string;
  readonly limits: PlanResourceLimits;
  readonly features: PlanFeatures;
}

export interface EntitlementAddOnInput {
  readonly effect: AddOnEffect;
  readonly compatiblePlanKeys: readonly string[];
}

/** Matches `EffectiveEntitlements` (`tenant.types.ts`) exactly. */
export interface EffectiveEntitlements {
  readonly organizationId: string;
  readonly limits: PlanResourceLimits;
  readonly features: PlanFeatures;
}

/** Matches `ResourceLimitStatus` (`tenant.types.ts`) exactly. */
export type ResourceLimitStatus = 'allowed' | 'limitReached' | 'unlimited' | 'unknown';

/** Matches `EntitlementGapAction` (`tenant.types.ts`) exactly. */
export type EntitlementGapAction = 'upgradePlan' | 'addOn' | 'none';
