/** Matches `OrganizationMembership` (atlas frontend `identity.types.ts`) field-for-field — this is what populates `CurrentUser.organizations`/`.organizationMemberships` (master plan §21 Phase P2). */
export interface OrganizationMembershipResponse {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly role: string;
  readonly permissions: readonly string[];
  readonly isPrimary: boolean;
  readonly joinedAt: string;
}
