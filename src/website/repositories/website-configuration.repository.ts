/**
 * WebsiteConfigurationRepository — every method takes a
 * `Prisma.TransactionClient` obtained from
 * `TenancyContextService.runInTenantContext`, matching every other
 * repository in this codebase's established rule. `academyId` doubles as
 * the primary key (§5.10's 1:1 design), so lookups never need a separate
 * `id` parameter.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma, WebsiteConfiguration } from '@prisma/client';

@Injectable()
export class WebsiteConfigurationRepository {
  findByAcademyId(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<WebsiteConfiguration | null> {
    return tx.websiteConfiguration.findUnique({ where: { academyId } });
  }

  /**
   * The public runtime's ONE eligibility query (master plan §21 P11: "the
   * publication condition part of the database lookup itself," never
   * fetch-then-check) — `status: 'published'` is part of the `WHERE`
   * clause, not a filter applied to the result afterward. Returns `null`
   * for a draft/failed/publishing configuration exactly the same way it
   * returns `null` for a nonexistent one — the public caller can never
   * distinguish "exists but not published" from "does not exist" through
   * this method's return shape alone.
   */
  findPublishedByAcademyId(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<WebsiteConfiguration | null> {
    return tx.websiteConfiguration.findFirst({
      where: { academyId, status: 'published' },
    });
  }

  create(
    tx: Prisma.TransactionClient,
    data: Prisma.WebsiteConfigurationCreateInput,
  ): Promise<WebsiteConfiguration> {
    return tx.websiteConfiguration.create({ data });
  }

  update(
    tx: Prisma.TransactionClient,
    academyId: string,
    data: Prisma.WebsiteConfigurationUpdateInput,
  ): Promise<WebsiteConfiguration> {
    return tx.websiteConfiguration.update({ where: { academyId }, data });
  }
}
