/** Matches `OrganizationMembership` (atlas frontend `identity.types.ts`) field-for-field — this is what populates `CurrentUser.organizations`/`.organizationMemberships` (master plan §21 Phase P2). */
export interface OrganizationMembershipResponse {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly role: string;
  readonly permissions: readonly string[];
  readonly isPrimary: boolean;
  readonly joinedAt: string;
  /**
   * New Customer Onboarding — COMPUTED on every read, never stored:
   * `role === 'owner' && organization.onboarding_completed_at IS NULL`
   * (docs/NEW_CUSTOMER_ONBOARDING.md §3.3). The frontend uses it only to
   * decide where `/dashboard` lands; it authorizes nothing.
   */
  readonly onboardingPending: boolean;
}
