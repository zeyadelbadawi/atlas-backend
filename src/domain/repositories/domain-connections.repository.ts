/**
 * DomainConnectionsRepository — every method takes a
 * `Prisma.TransactionClient` obtained from
 * `TenancyContextService.runInTenantContext`, matching every other
 * repository in this codebase's established rule. `upsert` on the unique
 * `academyId` throughout (mirrors `TrialPolicyRepository`'s singleton-row
 * discipline) — a fresh Academy has no row yet, and the first real
 * `addCustomDomain`/`verifyDomain` call must not race a
 * find-then-create window.
 */
import { Injectable } from '@nestjs/common';
import type { DomainConnection, Prisma } from '@prisma/client';

@Injectable()
export class DomainConnectionsRepository {
  findByAcademyId(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<DomainConnection | null> {
    return tx.domainConnection.findUnique({ where: { academyId } });
  }

  findByHostname(
    tx: Prisma.TransactionClient,
    hostname: string,
  ): Promise<DomainConnection | null> {
    return tx.domainConnection.findUnique({ where: { hostname } });
  }

  upsert(
    tx: Prisma.TransactionClient,
    academyId: string,
    data: Omit<Prisma.DomainConnectionUncheckedCreateInput, 'academyId'>,
  ): Promise<DomainConnection> {
    return tx.domainConnection.upsert({
      where: { academyId },
      create: { academyId, ...data },
      update: data,
    });
  }
}
