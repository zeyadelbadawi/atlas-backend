/**
 * AcademyStudentsRepository — Phase 1 (Extended Scope, Decision 11,
 * dependency D). Mirrors `AcademyMembersRepository` (`academy/
 * repositories/academy-members.repository.ts`) exactly, for the new,
 * separate `academy_students` table (see that migration's own doc
 * comment for why Students are not folded into `AcademyMember`/
 * `AcademyMemberRole`, which has no `student` role and is reserved for
 * staff).
 *
 * Lives in `TenancyModule`, not `AcademyModule`, so both `IdentityModule`
 * (self-registration, `AuthService.register`) and `AcademyModule`
 * (staff-created students, `AcademiesService.createStudent`) can inject
 * it without a circular module dependency — `AcademyModule` already
 * imports `IdentityModule`, so the reverse edge is not available; both
 * already import `TenancyModule` directly (see `TenancyModule`'s own doc
 * comment for this exact DAG discipline).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AcademyStudent } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class AcademyStudentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findForUserInAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<AcademyStudent | null> {
    return tx.academyStudent.findFirst({ where: { academyId, userId } });
  }

  /**
   * Deliberately takes the "unchecked" input shape (plain `academyId`/
   * `userId` scalars, never `academy: { connect }`/`user: { connect }`):
   * Prisma's nested-`connect` form issues its own SELECT against the
   * parent row to validate the relation BEFORE inserting, and that SELECT
   * is subject to `academies`' own RLS — which self-registration cannot
   * pass (it runs under `runInUserContext`, with no organization context
   * open at all yet). The real Postgres foreign-key constraint on
   * `academy_students.academy_id` still enforces the row genuinely
   * exists — Postgres FK checks are documented to bypass the referenced
   * table's row-security policies, exactly the "one narrow, necessary
   * exception" this codebase's own `SECURITY DEFINER` functions elsewhere
   * rely on the same underlying guarantee for.
   */
  create(
    tx: Prisma.TransactionClient,
    data: Prisma.AcademyStudentUncheckedCreateInput,
  ): Promise<AcademyStudent> {
    return tx.academyStudent.create({ data });
  }

  /**
   * The narrow academyId → organizationId lookup self-registration needs
   * to validate a caller-supplied Academy context BEFORE any tenant/user
   * context exists at all. Reuses the EXISTING `resolve_academy_organization`
   * `SECURITY DEFINER` function P11 already introduced — see
   * `AcademiesRepository.resolveOrganizationId`'s identical doc comment
   * (P13) for the established precedent this follows: "no new SQL
   * function, no new migration," one thin wrapper per consuming module
   * rather than a cross-module import that would create a cycle
   * (`AcademyModule`/`WebsiteModule`/`PublicWebsiteModule` all already
   * depend on `IdentityModule`/`TenancyModule` — never the reverse).
   */
  async resolveOrganizationId(academyId: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ organization_id: string }[]>(
      Prisma.sql`SELECT * FROM resolve_academy_organization(${academyId})`,
    );
    return rows[0]?.organization_id ?? null;
  }
}
