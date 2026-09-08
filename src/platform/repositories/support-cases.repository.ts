/**
 * SupportCasesRepository — `support_cases`. The Platform-Owner-facing
 * methods below (`findMany`/`findById`/`updateStatus`/`touch`) run under
 * `TenancyContextService.runInUserContext(platformOwnerId)`, gated by the
 * `support_cases_platform_*` RLS policies (P15) — no tenant scoping,
 * matching that migration's own doc comment.
 *
 * `create`/`findManyForRequester` (Phase 8) are the tenant-facing pair:
 * they run under `runInTenantAndUserContext`/`runInUserContext`
 * respectively, gated by the NEW `support_cases_requester_*` RLS policies
 * (see the P31 migration's own doc comment) — a caller may create a case
 * only as themselves, and may only ever read a case they personally
 * requested, never another member of the same organization's tickets.
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

  /** Phase 8 — the one tenant-facing write path. `requesterName`/`requesterEmail` are always resolved server-side from the acting user's own row (see `SupportCasesService.createCase`'s doc comment) — never client-supplied, matching every other "who did this" field in this codebase. */
  create(
    tx: Prisma.TransactionClient,
    data: Prisma.SupportCaseUncheckedCreateInput,
  ): Promise<SupportCaseWithOrganization> {
    return tx.supportCase.create({ data, include: WITH_ORGANIZATION });
  }

  /** Phase 8 — "my tickets," scoped by the `support_cases_requester_select` RLS policy to rows this exact caller requested; the `requesterUserId` filter here is a real, redundant-by-design application-layer check on top of that RLS, never the only boundary. */
  async findManyForRequester(
    tx: Prisma.TransactionClient,
    requesterUserId: string,
    filter: { readonly skip: number; readonly take: number },
  ): Promise<{ items: SupportCaseWithOrganization[]; totalItems: number }> {
    const where: Prisma.SupportCaseWhereInput = { requesterUserId };
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
}
