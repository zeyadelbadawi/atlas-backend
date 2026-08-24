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
import type { Academy, Prisma } from '@prisma/client';

export interface AcademyListFilter {
  readonly search?: string;
  readonly sortBy?: 'name' | 'slug' | 'createdAt' | 'updatedAt';
  readonly sortDirection?: 'asc' | 'desc';
  readonly skip: number;
  readonly take: number;
}

@Injectable()
export class AcademiesRepository {
  /** Bootstrap read — see this class's doc comment. Visible iff the caller belongs to the owning organization. */
  findVisibleToUser(tx: Prisma.TransactionClient, id: string): Promise<Academy | null> {
    return tx.academy.findUnique({ where: { id } });
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
}
