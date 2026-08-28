/**
 * `PlatformUserSummary`/`.Detail` response contracts — match
 * `platform-user.types.ts` (atlas frontend) field-for-field. Deliberately
 * narrow: exactly the fields the frontend contract declares, never
 * `passwordHash`/tokens/session data — see `PlatformUsersService`'s own
 * doc comment for the full "never selected, not just never returned"
 * discipline. `organizationMemberships` reuses
 * `OrganizationMembershipResponse` (P2's `CurrentUser` projection)
 * verbatim.
 */
import type { User, UserAccountStatus } from '@prisma/client';
import type { OrganizationMembershipResponse } from '../../tenancy/dto/organization-membership.contract';

/** The exact, narrow field set ever read from `users` for this surface — see `PlatformUsersRepository`'s own `select` clause, which is the real enforcement point. */
export type PlatformUserRow = Pick<
  User,
  'id' | 'name' | 'email' | 'status' | 'isPlatformOwner' | 'createdAt' | 'lastSignInAt'
>;

export interface PlatformUserSummaryResponse {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly status: UserAccountStatus;
  readonly organizationCount: number;
  readonly createdAt: string;
  readonly lastSignInAt?: string;
}

export interface PlatformUserDetailResponse extends PlatformUserSummaryResponse {
  readonly roles: readonly string[];
  readonly organizationMemberships: readonly OrganizationMembershipResponse[];
}

export function toPlatformUserSummaryResponse(
  user: PlatformUserRow,
  organizationCount: number,
): PlatformUserSummaryResponse {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    status: user.status,
    organizationCount,
    createdAt: user.createdAt.toISOString(),
    lastSignInAt: user.lastSignInAt?.toISOString(),
  };
}

export function toPlatformUserDetailResponse(
  user: PlatformUserRow,
  organizationMemberships: readonly OrganizationMembershipResponse[],
): PlatformUserDetailResponse {
  return {
    ...toPlatformUserSummaryResponse(user, organizationMemberships.length),
    // Matches `CurrentUser.roles`'s own derivation exactly (master plan
    // §9): `platform_owner` is the only global role string, sourced from
    // the real `is_platform_owner` column, never a fabricated catalog.
    roles: user.isPlatformOwner ? ['platform_owner'] : [],
    organizationMemberships,
  };
}
