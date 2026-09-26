/**
 * New Customer Onboarding — the seam through which `POST /auth/register`
 * creates the Organization, its owner membership, its subscription and its
 * Free Trial INSIDE the account's own transaction
 * (docs/NEW_CUSTOMER_ONBOARDING.md §3.2).
 *
 * WHY A PORT. `PlansModule` already imports `IdentityModule`, so the identity
 * layer cannot import the plans/tenancy services that do this work without
 * the codebase's first module cycle. The same problem was solved for
 * `POST /organizations` with an `onCreated` callback; here the work is
 * provided by the global `OnboardingModule` under this token and injected
 * `@Optional()` — an application (or test module) without it simply cannot
 * run the organization signup, which is the safe direction.
 */
import type { Prisma } from '@prisma/client';

export const SIGNUP_ORGANIZATION_PORT = Symbol('SIGNUP_ORGANIZATION_PORT');

/** The result of validating a signup's plan BEFORE anything is written. Opaque to the identity layer. */
export interface PreparedSignupOrganization {
  readonly organizationName: string;
  readonly trialPlanId: string | null;
}

export interface SignupOrganizationResult {
  readonly organizationId: string;
  readonly trialStarted: boolean;
  /** Outbox rows written in the transaction; the caller enqueues them after commit. */
  readonly outboxIds: readonly string[];
}

export interface SignupOrganizationPort {
  /** Throws the signup-specific 400s; writes nothing. */
  prepare(input: {
    readonly organizationName: string;
    readonly planId?: string;
  }): Promise<PreparedSignupOrganization>;

  /**
   * Runs inside the registration transaction. The caller has already set
   * `app.current_user_id` and `app.current_organization_id` on `tx`.
   */
  createInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      readonly organizationId: string;
      readonly owner: { readonly id: string; readonly email: string };
      readonly prepared: PreparedSignupOrganization;
      readonly context?: { readonly ipAddress?: string; readonly userAgent?: string };
    },
  ): Promise<SignupOrganizationResult>;

  /** Post-commit side effects `POST /organizations` also performs (a usage recompute). Never throws. */
  afterCommit(result: SignupOrganizationResult): Promise<void>;
}
