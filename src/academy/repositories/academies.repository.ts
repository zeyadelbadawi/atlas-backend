/**
 * AcademiesRepository — see `OrganizationMembershipsRepository`'s doc
 * comment for the general rule this follows: every method takes a
 * `Prisma.TransactionClient`, never the raw `PrismaService`, so it is
 * structurally impossible to call this repository without an RLS context
 * (tenant or user) already active.
 *
 * Two distinct contexts are used deliberately, matching
 * `AcademyScopeGuard`'s two-step bootstrap-then-reestablish flow (see its
 * doc comment):
 *   - `findVisibleToUser` runs inside `runInUserContext` — bootstraps an
 *     academy's `organizationId` for a caller who has supplied only an
 *     academy id, via the `academies_org_member_select` policy.
 *   - Every other method runs inside `runInTenantContext` — the "real" read
 *     the service performs after re-establishing proper tenant scope,
 *     mirroring `OrganizationsService.getById`'s "never trust the guard's
 *     own read" discipline.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Academy, Organization } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PLATFORM_DETAIL_MEMBER_CAP } from '../../tenancy/repositories/organization-memberships.repository';

export interface AcademyListFilter {
  readonly search?: string;
  readonly sortBy?: 'name' | 'slug' | 'createdAt' | 'updatedAt';
  readonly sortDirection?: 'asc' | 'desc';
  readonly skip: number;
  readonly take: number;
}

export type AcademyWithOrganizationAndCounts = Academy & {
  organization: Pick<Organization, 'id' | 'name'>;
  _count: { courses: number; members: number };
};

@Injectable()
export class AcademiesRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Bootstrap read — see this class's doc comment. Visible iff the caller belongs to the owning organization. */
  findVisibleToUser(tx: Prisma.TransactionClient, id: string): Promise<Academy | null> {
    return tx.academy.findUnique({ where: { id } });
  }

  /**
   * Phase P13 addition — the narrow academyId → organizationId lookup
   * `CourseOrdersService` needs to open a legitimate `runInTenantContext`
   * for a course a STUDENT (never an organization member) is buying.
   * Reuses the EXISTING `resolve_academy_organization` `SECURITY DEFINER`
   * function P11 already introduced for the identical "no session context
   * yet, but the caller legitimately needs this one id→id fact" problem
   * (`PublicHostnameResolutionRepository.resolveAcademyOrganization`,
   * P11's own precedent) — no new SQL function, no new migration. Callable
   * with NO tenant/user context set at all, exactly like
   * `PaymentsRepository.resolvePaymentOrganization` (P12/P13).
   */
  async resolveOrganizationId(academyId: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ organization_id: string }[]>(
      Prisma.sql`SELECT * FROM resolve_academy_organization(${academyId})`,
    );
    return rows[0]?.organization_id ?? null;
  }

  findById(tx: Prisma.TransactionClient, id: string): Promise<Academy | null> {
    return tx.academy.findUnique({ where: { id } });
  }

  findBySlug(tx: Prisma.TransactionClient, slug: string): Promise<Academy | null> {
    return tx.academy.findUnique({ where: { slug } });
  }

  async findManyForOrganization(
    tx: Prisma.TransactionClient,
    organizationId: string,
    filter: AcademyListFilter,
  ): Promise<{ items: Academy[]; totalItems: number }> {
    const where: Prisma.AcademyWhereInput = {
      organizationId,
      ...(filter.search
        ? { name: { contains: filter.search, mode: 'insensitive' as const } }
        : {}),
    };

    const [items, totalItems] = await Promise.all([
      tx.academy.findMany({
        where,
        orderBy: { [filter.sortBy ?? 'createdAt']: filter.sortDirection ?? 'desc' },
        skip: filter.skip,
        take: filter.take,
      }),
      tx.academy.count({ where }),
    ]);

    return { items, totalItems };
  }

  create(
    tx: Prisma.TransactionClient,
    data: Prisma.AcademyCreateInput,
  ): Promise<Academy> {
    return tx.academy.create({ data });
  }

  update(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.AcademyUpdateInput,
  ): Promise<Academy> {
    return tx.academy.update({ where: { id }, data });
  }

  /** Phase P15 — `PlatformOrganizationDetail.academies` (id/name/status refs only). Meaningful only inside `runInUserContext(platformOwnerId)` (the `academies_platform_select` policy); capped, not paginated — see `PLATFORM_DETAIL_MEMBER_CAP`. */
  findRefsForOrganization(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<Pick<Academy, 'id' | 'name' | 'status'>[]> {
    return tx.academy.findMany({
      where: { organizationId },
      select: { id: true, name: true, status: true },
      orderBy: { createdAt: 'desc' },
      take: PLATFORM_DETAIL_MEMBER_CAP,
    });
  }

  /** Phase P15 — the Platform Owner's cross-tenant academy list. Meaningful only inside `runInUserContext(platformOwnerId)` (the `academies_platform_select` policy). */
  async findManyAnyOrganization(
    tx: Prisma.TransactionClient,
    filter: { readonly search?: string; readonly skip: number; readonly take: number },
  ): Promise<{ items: AcademyWithOrganizationAndCounts[]; totalItems: number }> {
    const where: Prisma.AcademyWhereInput = filter.search
      ? { name: { contains: filter.search, mode: 'insensitive' as const } }
      : {};

    const [items, totalItems] = await Promise.all([
      tx.academy.findMany({
        where,
        include: {
          organization: { select: { id: true, name: true } },
          _count: { select: { courses: true, members: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: filter.skip,
        take: filter.take,
      }),
      tx.academy.count({ where }),
    ]);

    return { items, totalItems };
  }

  /** Phase P15 — the Platform Owner's cross-tenant academy detail read. Same RLS/context rule as `findManyAnyOrganization`. */
  findByIdAnyOrganization(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<AcademyWithOrganizationAndCounts | null> {
    return tx.academy.findUnique({
      where: { id },
      include: {
        organization: { select: { id: true, name: true } },
        _count: { select: { courses: true, members: true } },
      },
    });
  }
}
