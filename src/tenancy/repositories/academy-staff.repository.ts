/**
 * AcademyStaffRepository — foundational-audit fix
 * (ATLAS_FOUNDATIONAL_AUTH_TENANCY_AUDIT.md, Fix A hardening). A narrow,
 * read-only existence check against `academy_members` ("this codebase's
 * staffing/roster record", per `AcademiesService.addInstructor`'s own
 * doc comment) for `SaasLevelCallerGuard`.
 *
 * Lives in `TenancyModule`, not `AcademyModule` (which already owns the
 * full `AcademyMembersRepository`), for the EXACT same reason
 * `AcademyStudentsRepository` lives here instead of `AcademyModule` — see
 * that repository's own doc comment: `AcademyModule` imports
 * `TenancyModule` (and `PlansModule`), so `TenancyModule`/`PlansModule`
 * importing `AcademyModule` back would be this codebase's first module
 * cycle. This repository intentionally duplicates none of
 * `AcademyMembersRepository`'s real logic — it is a single, narrow
 * existence check reused only by the guard.
 *
 * Why this check exists at all: in every REAL grant path
 * (`AcademiesService.addManager`/`addInstructor`), an `academy_members`
 * row is always created atomically alongside a real
 * `organization_memberships` row (role `manager`/`instructor`), so
 * `SaasLevelCallerGuard`'s `organization_memberships`-only check already
 * catches a real Manager/Instructor on its own. This is defense in
 * depth for exactly the gap the audit's own regression testing found
 * live in this database: a staff row that exists WITHOUT a matching
 * organization membership (here, from dev-fixture data seeded by direct
 * upsert rather than through the real grant service) still correctly
 * fails the guard instead of being indistinguishable from a genuinely
 * brand-new, never-affiliated signup.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

@Injectable()
export class AcademyStaffRepository {
  /** Meaningful under `runInUserContext` alone — the `academy_members_self_select` RLS policy. */
  async existsForUser(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
    const row = await tx.academyMember.findFirst({
      where: { userId },
      select: { id: true },
    });
    return row !== null;
  }
}
