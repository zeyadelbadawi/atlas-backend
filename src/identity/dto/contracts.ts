/**
 * Response contracts and the `User` → `CurrentUser` projection.
 *
 * These interfaces mirror the atlas frontend's `src/types/identity.types.ts`
 * field-for-field — this file is the P1 half of the "response serializers
 * enforce the same narrow field allowlist" rule from master plan §16
 * ("PII / sensitive data"). `password_hash` (and any refresh/reset token
 * field) is structurally impossible to leak through `toCurrentUser` because
 * it never reads those columns off the `User` row in the first place.
 */
import type { User } from '@prisma/client';
import type { OrganizationMembershipResponse } from '../../tenancy/dto/organization-membership.contract';

export interface NotificationPreferences {
  readonly email: boolean;
  readonly push: boolean;
  readonly sms: boolean;
}

export interface UserPreferences {
  readonly theme?: string;
  readonly language?: string;
  readonly notifications?: NotificationPreferences;
}

/** Matches `OrganizationMembership` (`identity.types.ts`) — real as of Phase P2, populated from `organization_memberships` via `UserOrganizationsService`. */
export type OrganizationMembership = OrganizationMembershipResponse;

export interface CurrentUserResponse {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly avatar?: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly organizations: readonly OrganizationMembership[];
  readonly organizationMemberships: readonly OrganizationMembership[];
  readonly preferences?: UserPreferences;
  readonly createdAt: string;
  readonly lastSignInAt?: string;
}

export interface AuthenticationResponseContract {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresIn: number;
  readonly user: CurrentUserResponse;
}

export interface TokenRefreshResponseContract {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresIn: number;
}

/**
 * Projects a `users` row to `CurrentUser`. `roles`/`permissions` are
 * computed, never stored — matching master plan §9: the API surface
 * exposes only flat string arrays; `platform_owner` is the only global
 * role, and it comes from the real `is_platform_owner` column, never
 * inferred from a permission string. `organizations`/
 * `organizationMemberships` are real as of Phase P2 — the caller (identity
 * services) is responsible for fetching them via `UserOrganizationsService`
 * and passing the same array into both fields (the frontend type declares
 * them as two separate fields with identical shape; nothing distinguishes
 * their semantics, so they are always populated identically here).
 */
export function toCurrentUser(
  user: User,
  organizationMemberships: readonly OrganizationMembership[] = [],
): CurrentUserResponse {
  const preferences = (user.preferences ?? {}) as UserPreferences;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatar: user.avatarUrl ?? undefined,
    roles: user.isPlatformOwner ? ['platform_owner'] : [],
    permissions: [],
    organizations: organizationMemberships,
    organizationMemberships,
    preferences,
    createdAt: user.createdAt.toISOString(),
    lastSignInAt: user.lastSignInAt?.toISOString(),
  };
}
