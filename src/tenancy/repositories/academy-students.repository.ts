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
import { withSavepoint } from '../../common/database/savepoint.util';
import {
  isUniqueViolation,
  learnerNameTaken,
  lockAndCheckLearnerAdmission,
} from '../../common/name-uniqueness/name-uniqueness';

/**
 * W4 — what an admission does when the account's name is already held by
 * another (non-exempt) learner of the academy.
 *   - `interactive` (registration, academy-join, staff add, staff grant): a
 *     409 the person can act on, reported on `field`. `existingAccount` is the
 *     staff-add variant for an account whose name staff cannot edit.
 *   - `automatic` (sign-in auto-join, purchase/payment application): NEVER
 *     fails — the row is inserted `name_unique_exempt` and the caller records
 *     the clash (`nameClashExempted: true`).
 */
export type LearnerNamePolicy =
  | {
      readonly mode: 'interactive';
      readonly field?: string;
      readonly variant?: 'self' | 'existingAccount';
    }
  | { readonly mode: 'automatic' };

export interface LearnerAdmission {
  readonly student: AcademyStudent;
  /** True when an automatic admission clashed and was inserted exempt. */
  readonly nameClashExempted: boolean;
}

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
   * Foundational-audit fix (`SaasLevelCallerGuard`) — "does this user have
   * a real, staff/owner-created OR self-registered home-Academy
   * membership at all," independent of which Academy. Meaningful under
   * `runInUserContext` alone (the `academy_students_self_select` policy),
   * matching `OrganizationMembershipsRepository.findAllForUser`'s
   * identical "no tenant context needed" shape — this is exactly the
   * signal that was missing from `PlansController`/
   * `OrganizationsController.create`'s authorization: a caller with this
   * row is a genuine Academy-scoped Student and must never be treated as
   * SaaS-level-onboarding-eligible, regardless of having zero
   * `organization_memberships` rows.
   */
  async existsForUser(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
    const row = await tx.academyStudent.findFirst({
      where: { userId },
      select: { id: true },
    });
    return row !== null;
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
   * W4 — THE way a learner row is created: `create` plus the per-academy
   * name rule (see `LearnerNamePolicy`). Must run inside the caller's write
   * transaction:
   *   1. `academy_learner_admission_name_taken` takes the
   *      'learner-name:<academy>:<key>' advisory lock for the rest of the
   *      transaction and answers whether another non-exempt learner holds the
   *      account's current name key (a boolean definer: the caller may not be
   *      able to read the account or the roster under RLS);
   *   2. the insert runs in a SAVEPOINT, so a unique violation leaves the
   *      transaction usable;
   *   3. a P2002 is classified by asking the same check again: the name →
   *      the policy's answer; anything else (the `(academy, user)` index —
   *      a concurrent second admission) → rethrown unchanged for the caller's
   *      existing handling.
   */
  async admit(
    tx: Prisma.TransactionClient,
    data: Prisma.AcademyStudentUncheckedCreateInput,
    policy: LearnerNamePolicy,
  ): Promise<LearnerAdmission> {
    const refuse = () =>
      learnerNameTaken(
        policy.mode === 'interactive' ? (policy.field ?? 'name') : 'name',
        policy.mode === 'interactive' ? (policy.variant ?? 'self') : 'self',
      );
    const taken = await lockAndCheckLearnerAdmission(tx, data.academyId, data.userId);
    if (taken && policy.mode === 'interactive') throw refuse();

    try {
      const student = await withSavepoint(tx, () =>
        tx.academyStudent.create({ data: { ...data, nameUniqueExempt: taken } }),
      );
      return { student, nameClashExempted: taken };
    } catch (error) {
      if (!isUniqueViolation(error) || taken) throw error;
      const nameClash = await lockAndCheckLearnerAdmission(
        tx,
        data.academyId,
        data.userId,
      );
      if (!nameClash) throw error;
      if (policy.mode === 'interactive') throw refuse();
      const student = await tx.academyStudent.create({
        data: { ...data, nameUniqueExempt: true },
      });
      return { student, nameClashExempted: true };
    }
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

  /**
   * Phase 6 — the public statistics endpoint's real, live student count.
   * Counts only students who currently have access: `status: 'active'` and
   * not blocked — the same pair `assertActiveEnrollment`, the roster's
   * "active" filter and announcement fan-out use, and the public twin of
   * the instructor count's `status: 'active'`. A blocked, inactive or
   * pending membership is not advertised as a student.
   */
  countActiveForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<number> {
    return tx.academyStudent.count({
      where: { academyId, status: 'active', blockedAt: null },
    });
  }
}
