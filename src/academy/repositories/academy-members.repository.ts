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
   * `AcademyScopeGuard`'s organization-owner rule, for the service-level
   * checks: the OWNER of the academy's organization is the implicit owner
   * of every academy in it, with or without an `academy_members` row (a
   * seeded academy, or one created before the owner's row existed, has
   * none). Only `organization_memberships.role = 'owner'` counts, never an
   * organization manager or member. Readable in the tenant context (and in
   * the user context, through the `_self_select` policy), like the guard's
   * own lookup.
   */
  async isOrganizationOwnerOfAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<boolean> {
    const academy = await tx.academy.findUnique({
      where: { id: academyId },
      select: { organizationId: true },
    });
    if (!academy) return false;
    const ownerMembership = await tx.organizationMembership.findFirst({
      where: { organizationId: academy.organizationId, userId, role: 'owner' },
      select: { id: true },
    });
    return ownerMembership !== null;
  }

  /**
   * The caller's effective MANAGING role in this academy, by the guard's
   * rule: their active staff row's role when it is one of `managingRoles`,
   * otherwise `owner` when they own the academy's organization, otherwise
   * `null`. Every service-level "can manage this academy" check uses this,
   * so the guard and the services can no longer disagree about the
   * organization owner.
   */
  async findManagingRole(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
    managingRoles: ReadonlySet<string>,
  ): Promise<AcademyMemberRole | null> {
    const membership = await this.findForUserInAcademy(tx, academyId, userId);
    if (membership && managingRoles.has(membership.role)) return membership.role;
    if (managingRoles.has('owner')) {
      if (await this.isOrganizationOwnerOfAcademy(tx, academyId, userId)) return 'owner';
    }
    return null;
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

  /** Every staff row that still counts as a member — a removed (`inactive`) row does not. */
  countAll(tx: Prisma.TransactionClient, academyId: string): Promise<number> {
    return tx.academyMember.count({ where: { academyId, status: { not: 'inactive' } } });
  }

  /**
   * The user's ACTIVE staff rows in OTHER academies of the same
   * organization — whether removing them from one academy should also end
   * their organization membership (`AcademiesService.removeStaffMember`).
   */
  countActiveForUserInOtherAcademies(
    tx: Prisma.TransactionClient,
    organizationId: string,
    userId: string,
    excludeAcademyId: string,
  ): Promise<number> {
    return tx.academyMember.count({
      where: {
        userId,
        status: 'active',
        academyId: { not: excludeAcademyId },
        academy: { organizationId },
      },
    });
  }

  /**
   * Staff removal: the row is kept, marked `inactive` — the membership's
   * history (and every audit row naming it) stays intact, and every
   * authorization lookup (`findForUserInAcademy`, `AcademyScopeGuard`, the
   * `is_academy_member()`/`can_author_course_content()` RLS helpers) reads
   * active rows only, so the change takes effect on the very next request.
   * Admitted by `academy_members_owner_update` (organization owner only).
   */
  deactivate(tx: Prisma.TransactionClient, id: string): Promise<AcademyMember> {
    return tx.academyMember.update({ where: { id }, data: { status: 'inactive' } });
  }

  /** Re-adding a previously removed member: the same row, active again, with the newly granted role. */
  reactivate(
    tx: Prisma.TransactionClient,
    id: string,
    role: AcademyMemberRole,
  ): Promise<AcademyMember> {
    return tx.academyMember.update({
      where: { id },
      data: { status: 'active', role, joinedAt: new Date() },
    });
  }

  create(
    tx: Prisma.TransactionClient,
    data: Prisma.AcademyMemberCreateInput,
  ): Promise<AcademyMember> {
    return tx.academyMember.create({ data });
  }
}
