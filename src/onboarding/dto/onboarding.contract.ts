/**
 * New Customer Onboarding — wire contracts (docs/NEW_CUSTOMER_ONBOARDING.md
 * §3). The frontend's `onboarding.types.ts` mirrors these field-for-field.
 */
import type { PaymentLifecycleStatus, TenantSubscriptionStatus } from '@prisma/client';
import type { PlanResponse } from '../../plans/dto/plan.contract';

export interface SignupOptionsResponse {
  /** `FLAG_SIGNUP_ORGANIZATION_MODE === 'on'`. */
  readonly organizationSignup: boolean;
  /** `TrialPolicy.enabled`. */
  readonly trialsEnabled: boolean;
  /** Active, customer-facing, trial-eligible plans; empty when trials are disabled. */
  readonly trialPlans: readonly PlanResponse[];
}

export type OnboardingStepKey = 'plan' | 'academy' | 'branding' | 'website' | 'course';
export type OnboardingStepRequirement = 'prerequisite' | 'required' | 'recommended';
export type OnboardingStepStatus =
  'complete' | 'in_progress' | 'incomplete' | 'blocked' | 'awaiting_confirmation';

export interface OnboardingStep {
  readonly key: OnboardingStepKey;
  readonly requirement: OnboardingStepRequirement;
  readonly status: OnboardingStepStatus;
}

export interface OnboardingStatusResponse {
  readonly organizationId: string;
  readonly completedAt: string | null;
  readonly pending: boolean;
  readonly requiredComplete: boolean;
  /** The ONLY signal that may produce "your academy is ready" wording. */
  readonly readyLabelAllowed: boolean;
  readonly subscription: {
    readonly status: TenantSubscriptionStatus;
    /** Null while `no_plan` — the plan column then holds a placeholder, never "your plan". */
    readonly planKey: string | null;
    readonly trialEndsAt: string | null;
    readonly trialAvailable: boolean;
  };
  readonly latestSubscriptionPayment: {
    readonly id: string;
    readonly status: PaymentLifecycleStatus;
    readonly reviewStatus: string;
    /** A translatable message key, e.g. `errors.payment.rejectedByReviewer`. */
    readonly failureReason: string | null;
    /** The Platform Owner's review note, shown verbatim when present. */
    readonly reviewNotes: string | null;
    readonly planKey: string;
  } | null;
  readonly academy: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly host: string | null;
    readonly logoUrl: string | null;
  } | null;
  readonly provisioning: {
    readonly requestId: string;
    readonly status: string;
    readonly currentStepKey: string | null;
    readonly failed: boolean;
  } | null;
  readonly steps: readonly OnboardingStep[];
  readonly nextStep: OnboardingStepKey | 'summary';
}
