/**
 * SubdomainAllocationsRepository — read-only from P11's perspective (no
 * create method existed there: allocating a subdomain was documented as
 * "P14's job"). This phase (Provisioning Orchestration) is the real first
 * writer — `create` reuses the exact `_insert` RLS policy the P11
 * migration already shipped, unused until now (see that migration's own
 * doc comment). Every tenant-context method takes a
 * `Prisma.TransactionClient`, matching every other repository in this
 * codebase's established rule.
 *
 * `existsBySubdomain` is the one method that deliberately does NOT take a
 * transaction client — subdomain uniqueness is a GLOBAL fact (matches the
 * real `@unique` constraint on `subdomain`), unanswerable from inside any
 * one tenant's own RLS context, so it calls the P14 migration's own
 * `subdomain_is_taken` `SECURITY DEFINER` function directly via
 * `PrismaService`, mirroring `AcademiesRepository.resolveOrganizationId`'s
 * (P13) identical "no legitimate session context for this one narrow
 * cross-tenant fact" precedent.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { SubdomainAllocation } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class SubdomainAllocationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByAcademyId(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<SubdomainAllocation | null> {
    return tx.subdomainAllocation.findUnique({ where: { academyId } });
  }

  /** Phase P14 — the real allocation write. `academyId` is `@unique`, so a redelivered/retried call that already succeeded once simply hits the real database unique constraint on a second attempt — callers check `findByAcademyId` first (the fast, expected idempotent path) and only reach here when no row exists yet. */
  create(
    tx: Prisma.TransactionClient,
    data: Prisma.SubdomainAllocationUncheckedCreateInput,
  ): Promise<SubdomainAllocation> {
    return tx.subdomainAllocation.create({ data });
  }

  /**
   * P63g — when the platform base domain changes, every allocation's
   * advertised `full_host` follows it. Cross-tenant by nature (one
   * platform fact touching every tenant's row), so it goes through the
   * `rewrite_subdomain_full_hosts` definer function rather than any tenant
   * context. Returns each label with the host it previously advertised so
   * the caller can drop the stale cache entries.
   */
  async rewriteFullHosts(
    prisma: PrismaService,
    baseDomain: string,
  ): Promise<{ subdomain: string; previousFullHost: string | null }[]> {
    const rows = await prisma.$queryRaw<
      { subdomain: string; previous_full_host: string | null }[]
    >(Prisma.sql`SELECT * FROM rewrite_subdomain_full_hosts(${baseDomain})`);
    return rows.map((row) => ({
      subdomain: row.subdomain,
      previousFullHost: row.previous_full_host,
    }));
  }

  /** Phase P14 — global, context-free availability check. See this class's own doc comment. */
  async existsBySubdomain(subdomain: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ subdomain_is_taken: boolean }[]>(
      Prisma.sql`SELECT subdomain_is_taken(${subdomain}) AS subdomain_is_taken`,
    );
    return rows[0]?.subdomain_is_taken ?? false;
  }
}
