/**
 * SubdomainAllocationsRepository — read-only from P11's perspective. No
 * create/update method exists here: allocating a subdomain is P14's job
 * (Provisioning Orchestration) — confirmed by direct inspection, the real
 * `DomainService` (frontend) has no "allocate subdomain" method at all.
 * Every method takes a `Prisma.TransactionClient`, matching every other
 * repository in this codebase's established rule.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma, SubdomainAllocation } from '@prisma/client';

@Injectable()
export class SubdomainAllocationsRepository {
  findByAcademyId(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<SubdomainAllocation | null> {
    return tx.subdomainAllocation.findUnique({ where: { academyId } });
  }
}
