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
import {
  BASE_USER_PERMISSIONS,
  PLATFORM_OWNER_PERMISSIONS,
} from '../constants/platform-permissions.constants';

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

/** P64 Phase 1 (AD-4) — the derived principal kind; see `PrincipalResolverService`. */
export type PrincipalKindResponse =
  'platform_owner' | 'staff' | 'learner' | 'unaffiliated';

export interface LearnerAcademyResponse {
  readonly academyId: string;
  readonly name: string;
  readonly slug: string;
  readonly host?: string;
  readonly membershipStatus: string;
  readonly blocked: boolean;
}

export interface CurrentUserResponse {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly avatar?: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly organizations: readonly OrganizationMembership[];
  readonly organizationMemberships: readonly OrganizationMembership[];
  /** P64 Phase 1 — derived, never stored; the frontend routes on it. */
  readonly principalKind: PrincipalKindResponse;
  /** P64 Phase 1 — every academy this user is a student of (with its public host). */
  readonly academies: readonly LearnerAcademyResponse[];
  /**
   * P64 Phase 1 (§T) — whether the management-surface refusal is switched
   * on for THIS principal, so the interface can route on the server's own
   * answer instead of re-deriving one. During a staged rollout a learner
   * the rollout has not reached is still admitted to the dashboard by the
   * backend; the frontend must not send them to the academy chooser and
   * strand them. Always `true` for a learner once the rollout completes,
   * and irrelevant for every other principal kind.
   */
  readonly managementSurfaceEnforced: boolean;
  readonly preferences?: UserPreferences;
  readonly createdAt: string;
  readonly lastSignInAt?: string;
}

export interface AuthenticationSessionContract {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresIn: number;
  readonly user: CurrentUserResponse;
  /** Absent on a real session. Present and `true` only on the challenge variant below. */
  readonly twoFactorRequired?: false;
}

/**
 * Phase 10.3 — the response when a correct password is not enough.
 *
 * Deliberately carries NO token of any kind. `challengeId` is an opaque
 * reference to a short-lived Redis entry that only
 * `POST /auth/2fa/verify` accepts; it authenticates nothing and cannot be
 * sent as a bearer token anywhere. A client that mistakes it for one gets
 * a 401 from every protected route.
 */
export interface TwoFactorChallengeContract {
  readonly twoFactorRequired: true;
  readonly challengeId: string;
  /** Seconds until the challenge expires and the user must sign in again. */
  readonly expiresIn: number;
}

/**
 * A sign-in either establishes a session or demands a second factor.
 * Modelled as a union so a caller cannot read `accessToken` off a
 * challenge response without the compiler objecting.
 */
export type AuthenticationResponseContract =
  AuthenticationSessionContract | TwoFactorChallengeContract;

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
 * inferred from a permission string. `permissions` mirrors that same
 * `is_platform_owner` source via `PLATFORM_OWNER_PERMISSIONS` — a real,
 * non-empty catalog, not the `[]` this returned before (see that
 * constant's doc comment for the live-confirmed bug this closes:
 * `platform.payment.approve` etc. never being held by anyone, including
 * the real seeded Platform Owner). `organizations`/
 * `organizationMemberships` are real as of Phase P2 — the caller (identity
 * services) is responsible for fetching them via `UserOrganizationsService`
 * and passing the same array into both fields (the frontend type declares
 * them as two separate fields with identical shape; nothing distinguishes
 * their semantics, so they are always populated identically here).
 */
export function toCurrentUser(
  user: User,
  organizationMemberships: readonly OrganizationMembership[] = [],
  principal: {
    readonly kind: PrincipalKindResponse;
    readonly academies: readonly LearnerAcademyResponse[];
    readonly managementSurfaceEnforced?: boolean;
  } = { kind: user.isPlatformOwner ? 'platform_owner' : 'unaffiliated', academies: [] },
): CurrentUserResponse {
  const preferences = (user.preferences ?? {}) as UserPreferences;

  return {
    principalKind: principal.kind,
    academies: principal.academies,
    // Defaults to enforced: a caller that did not resolve the rollout
    // state must never be the reason a learner is routed as if the
    // refusal were off.
    managementSurfaceEnforced: principal.managementSurfaceEnforced ?? true,
    id: user.id,
    email: user.email,
    name: user.name,
    avatar: user.avatarUrl ?? undefined,
    roles: user.isPlatformOwner ? ['platform_owner'] : [],
    permissions: user.isPlatformOwner
      ? [...PLATFORM_OWNER_PERMISSIONS, ...BASE_USER_PERMISSIONS]
      : BASE_USER_PERMISSIONS,
    organizations: organizationMemberships,
    organizationMemberships,
    preferences,
    createdAt: user.createdAt.toISOString(),
    lastSignInAt: user.lastSignInAt?.toISOString(),
  };
}
