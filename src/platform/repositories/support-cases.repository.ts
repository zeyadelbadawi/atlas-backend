/**
 * SupportCasesRepository — `support_cases` is Platform-owned, RLS-
 * protected purely by `is_platform_owner()` (no tenant scoping — see the
 * P15 migration's own doc comment). Every method takes a
 * `Prisma.TransactionClient` from
 * `TenancyContextService.runInUserContext(platformOwnerId)`, matching
 * every other repository's established rule. No `create` method exists —
 * see the P15 migration's own doc comment for why there is deliberately
 * no INSERT policy/path for this table in this phase.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma, SupportCaseStatus } from '@prisma/client';
import type { SupportCaseWithOrganization } from '../dto/support-case.contract';

const WITH_ORGANIZATION = {
  organization: { select: { id: true, name: true } },
} as const;

export interface SupportCaseListFilter {
  readonly search?: string;
  readonly status?: SupportCaseStatus;
  readonly skip: number;
  readonly take: number;
}

@Injectable()
export class SupportCasesRepository {
  async findMany(
    tx: Prisma.TransactionClient,
    filter: SupportCaseListFilter,
  ): Promise<{ items: SupportCaseWithOrganization[]; totalItems: number }> {
    const where: Prisma.SupportCaseWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.search
        ? {
            OR: [
              { subject: { contains: filter.search, mode: 'insensitive' as const } },
              {
                requesterName: { contains: filter.search, mode: 'insensitive' as const },
              },
              {
                requesterEmail: { contains: filter.search, mode: 'insensitive' as const },
              },
            ],
          }
        : {}),
    };

    const [items, totalItems] = await Promise.all([
      tx.supportCase.findMany({
        where,
        include: WITH_ORGANIZATION,
        orderBy: { createdAt: 'desc' },
        skip: filter.skip,
        take: filter.take,
      }),
      tx.supportCase.count({ where }),
    ]);

    return { items, totalItems };
  }

  findById(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<SupportCaseWithOrganization | null> {
    return tx.supportCase.findUnique({ where: { id }, include: WITH_ORGANIZATION });
  }

  updateStatus(
    tx: Prisma.TransactionClient,
    id: string,
    status: SupportCaseStatus,
  ): Promise<SupportCaseWithOrganization> {
    return tx.supportCase.update({
      where: { id },
      data: { status },
      include: WITH_ORGANIZATION,
    });
  }

  /** Bumps `updatedAt` without changing `status` — used when a reply is posted, matching the frontend's own `updatedAt` field semantics ("last activity," not "last status change"). */
  touch(tx: Prisma.TransactionClient, id: string): Promise<SupportCaseWithOrganization> {
    return tx.supportCase.update({
      where: { id },
      data: { updatedAt: new Date() },
      include: WITH_ORGANIZATION,
    });
  }
}
