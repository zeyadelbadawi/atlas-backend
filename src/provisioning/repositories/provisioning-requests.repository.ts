/**
 * ProvisioningRequestsRepository — every tenant-context method takes a
 * `Prisma.TransactionClient` obtained from `TenancyContextService`, never
 * the raw `PrismaService`, matching every other repository in this
 * codebase's established rule.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma, ProvisioningRequest } from '@prisma/client';

@Injectable()
export class ProvisioningRequestsRepository {
  findById(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<ProvisioningRequest | null> {
    return tx.provisioningRequest.findUnique({ where: { id } });
  }

  findByIdempotencyKey(
    tx: Prisma.TransactionClient,
    organizationId: string,
    idempotencyKey: string,
  ): Promise<ProvisioningRequest | null> {
    return tx.provisioningRequest.findUnique({
      where: { organizationId_idempotencyKey: { organizationId, idempotencyKey } },
    });
  }

  async findManyForOrganization(
    tx: Prisma.TransactionClient,
    organizationId: string,
    filter: { readonly search?: string; readonly skip: number; readonly take: number },
  ): Promise<{ items: ProvisioningRequest[]; totalItems: number }> {
    const where: Prisma.ProvisioningRequestWhereInput = {
      organizationId,
      ...(filter.search
        ? {
            requestedAcademyName: {
              contains: filter.search,
              mode: 'insensitive' as const,
            },
          }
        : {}),
    };

    const [items, totalItems] = await Promise.all([
      tx.provisioningRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: filter.skip,
        take: filter.take,
      }),
      tx.provisioningRequest.count({ where }),
    ]);

    return { items, totalItems };
  }

  /** Phase P15 — `PlatformAcademyDetail.provisioningStatus`. Same RLS/context rule as `findByIdAnyOrganization` below (`academyId` is `@unique`, so at most one row). */
  findByAcademyIdAnyOrganization(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<ProvisioningRequest | null> {
    return tx.provisioningRequest.findFirst({ where: { academyId } });
  }

  /** Platform-review lookup — no `organizationId` filter; RLS's `provisioning_requests_platform_select` policy is the only thing that makes this return a row, requiring `TenancyContextService.runInUserContext` with a verified Platform Owner's id already active. */
  findByIdAnyOrganization(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<ProvisioningRequest | null> {
    return tx.provisioningRequest.findFirst({ where: { id } });
  }

  async findManyAnyOrganization(
    tx: Prisma.TransactionClient,
    filter: { readonly search?: string; readonly skip: number; readonly take: number },
  ): Promise<{ items: ProvisioningRequest[]; totalItems: number }> {
    const where: Prisma.ProvisioningRequestWhereInput = filter.search
      ? {
          requestedAcademyName: { contains: filter.search, mode: 'insensitive' as const },
        }
      : {};

    const [items, totalItems] = await Promise.all([
      tx.provisioningRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: filter.skip,
        take: filter.take,
      }),
      tx.provisioningRequest.count({ where }),
    ]);

    return { items, totalItems };
  }

  /** `UncheckedCreateInput` (plain scalar FKs) — the creating actor is always an ordinary Organization member (never a Platform Owner, never a non-member), so `organizations`/`users` are always genuinely visible under this call's own tenant context; kept Unchecked anyway for symmetry with every other P14 write and because `triggeringPaymentId` (when present) references a `payments` row this same tenant context already legitimately sees. */
  create(
    tx: Prisma.TransactionClient,
    data: Prisma.ProvisioningRequestUncheckedCreateInput,
  ): Promise<ProvisioningRequest> {
    return tx.provisioningRequest.create({ data });
  }

  /** `UncheckedUpdateInput` — every caller sets plain scalar fields (`academyId`, `status`, `currentStepKey`, timestamps, `attemptCount`), never a relation `connect`; keeps this consistent with `create`'s own Unchecked choice above and avoids a nested-`connect` RLS pre-check on `academyId` for a row this tenant context already legitimately owns. */
  update(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.ProvisioningRequestUncheckedUpdateInput,
  ): Promise<ProvisioningRequest> {
    return tx.provisioningRequest.update({ where: { id }, data });
  }
}
