/**
 * AcademyMembersRepository — see `AcademiesRepository`'s doc comment for the
 * shared rule (`Prisma.TransactionClient` only). Every method here runs
 * inside `runInTenantContext`, protected by `academy_members_tenant_select`
 * / `academy_members_insert` — never `runInUserContext`, since by the time
 * any of these run, `AcademyScopeGuard` has already resolved and
 * re-established the real tenant context.
 */
import { Injectable } from '@nestjs/common';
import type { AcademyMember, AcademyMemberRole, Prisma, User } from '@prisma/client';

export type AcademyMemberWithUser = AcademyMember & {
  user: Pick<User, 'id' | 'name' | 'email'>;
};

@Injectable()
export class AcademyMembersRepository {
  /**
   * The user's ACTIVE staff row in this academy — the authorization lookup.
   * An `inactive` or `pending` row grants nothing (security review finding
   * 5: routes outside `AcademyScopeGuard` authorised on this lookup alone,
   * and some never checked the status). Mirrors `is_academy_member()` /
   * `can_author_course_content()` (20261104000341).
   */
  findForUserInAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<AcademyMember | null> {
    return tx.academyMember.findFirst({ where: { academyId, userId, status: 'active' } });
  }

  /**
   * The user's staff row in this academy WHATEVER its status — only for
   * "is there already a row?" questions (adding a member, the member
   * lookup), never for authorization.
   */
  findAnyStatusForUserInAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<AcademyMember | null> {
    return tx.academyMember.findFirst({ where: { academyId, userId } });
  }

  /** W5 — the caller's ACTIVE staff rows among the given academies (the academy list's per-row role). */
  findActiveForUserInAcademies(
    tx: Prisma.TransactionClient,
    userId: string,
    academyIds: readonly string[],
  ): Promise<Pick<AcademyMember, 'academyId' | 'role'>[]> {
    if (academyIds.length === 0) return Promise.resolve([]);
    return tx.academyMember.findMany({
      where: { userId, status: 'active', academyId: { in: [...academyIds] } },
      select: { academyId: true, role: true },
    });
  }

  async findManyForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    options: { skip: number; take: number },
  ): Promise<{ items: AcademyMemberWithUser[]; totalItems: number }> {
    const where: Prisma.AcademyMemberWhereInput = { academyId };

    const [items, totalItems] = await Promise.all([
      tx.academyMember.findMany({
        where,
        orderBy: { joinedAt: 'asc' },
        skip: options.skip,
        take: options.take,
        include: { user: { select: { id: true, name: true, email: true } } },
      }),
      tx.academyMember.count({ where }),
    ]);

    return { items, totalItems };
  }

  countByRoleAndStatus(
    tx: Prisma.TransactionClient,
    academyId: string,
    role: AcademyMemberRole,
  ): Promise<number> {
    return tx.academyMember.count({ where: { academyId, role, status: 'active' } });
  }

  countAll(tx: Prisma.TransactionClient, academyId: string): Promise<number> {
    return tx.academyMember.count({ where: { academyId } });
  }

  create(
    tx: Prisma.TransactionClient,
    data: Prisma.AcademyMemberCreateInput,
  ): Promise<AcademyMember> {
    return tx.academyMember.create({ data });
  }
}
