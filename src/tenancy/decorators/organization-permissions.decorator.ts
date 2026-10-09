/**
 * `@OrganizationPermissions(...)` — the per-route organization-permission
 * requirement `OrganizationMembershipGuard` enforces once it has read the
 * caller's membership row (the organization-level counterpart of
 * `@AcademyRoles(...)` for `AcademyScopeGuard`).
 *
 * The guard alone proves only that SOME membership row exists — a
 * Manager's or Instructor's row passes it exactly like the owner's. A
 * route that is the organization owner's (money, billing configuration)
 * declares the persisted permission string that only
 * `ORGANIZATION_OWNER_PERMISSIONS` carries
 * (`src/tenancy/constants/organization-permissions.constants.ts`), and the
 * guard refuses a membership without it with the same 403 the inline
 * owner checks (`TenantSubscriptionController.assertCanManageBilling`)
 * already use. Every listed permission is required.
 *
 * Declared, not re-implemented per handler: a route added to an annotated
 * controller inherits the class-level requirement instead of silently
 * having none. Applied at method level it overrides the class-level one.
 */
import { SetMetadata } from '@nestjs/common';

export const ORGANIZATION_PERMISSIONS_KEY = 'atlas:organizationPermissions';

export const OrganizationPermissions = (...permissions: readonly string[]) =>
  SetMetadata(ORGANIZATION_PERMISSIONS_KEY, permissions);
