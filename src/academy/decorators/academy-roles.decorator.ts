/**
 * `@AcademyRoles(...)` — the per-route academy-role requirement that
 * `AcademyScopeGuard` enforces once it has resolved the caller's role IN
 * THE ACADEMY BEING ADDRESSED (W5, finding F12).
 *
 * The guard alone already refuses anyone who is neither the organization
 * owner nor an ACTIVE `academy_members` row of this academy. This
 * decorator narrows that further for routes that need a particular tier
 * (for example the managing tier for the academy overview). The
 * organization owner resolves to `owner`, so every list here that names
 * `owner` keeps the organization owner in.
 *
 * Applied at method level it overrides a class-level declaration.
 */
import { SetMetadata } from '@nestjs/common';
import type { AcademyMemberRole } from '@prisma/client';

export const ACADEMY_ROLES_KEY = 'atlas:academyRoles';

/** Every staff role an `academy_members` row can hold — "any active staff member of this academy". */
export const ACADEMY_STAFF_ROLES: readonly AcademyMemberRole[] = [
  'owner',
  'administrator',
  'manager',
  'instructor',
  'staff',
];

/** The managing tier every academy write already requires (`MANAGING_ROLES` in the services). */
export const ACADEMY_MANAGING_ROLES: readonly AcademyMemberRole[] = [
  'owner',
  'administrator',
  'manager',
];

/** The teaching tier: the managing tier plus instructors (course builder, live sessions). */
export const ACADEMY_TEACHING_ROLES: readonly AcademyMemberRole[] = [
  ...ACADEMY_MANAGING_ROLES,
  'instructor',
];

export const AcademyRoles = (...roles: readonly AcademyMemberRole[]) =>
  SetMetadata(ACADEMY_ROLES_KEY, roles);
