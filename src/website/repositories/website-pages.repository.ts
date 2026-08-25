/**
 * WebsitePagesRepository — every method takes a `Prisma.TransactionClient`
 * obtained from `TenancyContextService.runInTenantContext`, matching every
 * other repository in this codebase's established rule. `academyId` is
 * always explicit, never inferred (master plan §24).
 */
import { Injectable } from '@nestjs/common';
import type { Prisma, WebsiteCorePageType, WebsitePage } from '@prisma/client';

export interface WebsitePageListFilter {
  readonly search?: string;
  readonly skip: number;
  readonly take: number;
}

@Injectable()
export class WebsitePagesRepository {
  findById(
    tx: Prisma.TransactionClient,
    academyId: string,
    id: string,
  ): Promise<WebsitePage | null> {
    return tx.websitePage.findFirst({ where: { id, academyId } });
  }

  findBySlug(
    tx: Prisma.TransactionClient,
    academyId: string,
    slug: string,
  ): Promise<WebsitePage | null> {
    return tx.websitePage.findUnique({ where: { academyId_slug: { academyId, slug } } });
  }

  findCoreByType(
    tx: Prisma.TransactionClient,
    academyId: string,
    coreType: WebsiteCorePageType,
  ): Promise<WebsitePage | null> {
    return tx.websitePage.findFirst({ where: { academyId, pageType: 'core', coreType } });
  }

  findAllCore(tx: Prisma.TransactionClient, academyId: string): Promise<WebsitePage[]> {
    return tx.websitePage.findMany({ where: { academyId, pageType: 'core' } });
  }

  /**
   * The public runtime's page-list eligibility query (master plan §21
   * P11) — `visible: true` is part of the `WHERE` clause itself, never a
   * post-fetch filter. Callers must ALSO have already confirmed the
   * Academy's `WebsiteConfiguration.status === 'published'`
   * (`WebsiteConfigurationRepository.findPublishedByAcademyId`) before
   * calling this — a page's own `visible` flag is independent of, and
   * insufficient on its own to prove, whole-website publication.
   */
  findAllPublished(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<WebsitePage[]> {
    return tx.websitePage.findMany({ where: { academyId, visible: true } });
  }

  /** The public runtime's single-page eligibility query — same `visible: true` WHERE-clause discipline as `findAllPublished`. `null` for a hidden page exactly the same way as a nonexistent slug — see that method's own doc comment. */
  findPublishedBySlug(
    tx: Prisma.TransactionClient,
    academyId: string,
    slug: string,
  ): Promise<WebsitePage | null> {
    return tx.websitePage.findFirst({ where: { academyId, slug, visible: true } });
  }

  /** Every page for an Academy, unpaginated — used for reference validation (navigation/CTA `pageId` existence checks) where a full in-memory id set is the simplest correct approach. */
  findAllForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<WebsitePage[]> {
    return tx.websitePage.findMany({ where: { academyId } });
  }

  async findManyForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    filter: WebsitePageListFilter,
  ): Promise<{ items: WebsitePage[]; totalItems: number }> {
    const where: Prisma.WebsitePageWhereInput = {
      academyId,
      ...(filter.search
        ? { title: { contains: filter.search, mode: 'insensitive' as const } }
        : {}),
    };

    const [items, totalItems] = await Promise.all([
      tx.websitePage.findMany({
        where,
        orderBy: [{ pageType: 'asc' }, { createdAt: 'asc' }],
        skip: filter.skip,
        take: filter.take,
      }),
      tx.websitePage.count({ where }),
    ]);

    return { items, totalItems };
  }

  create(
    tx: Prisma.TransactionClient,
    data: Prisma.WebsitePageCreateInput,
  ): Promise<WebsitePage> {
    return tx.websitePage.create({ data });
  }

  update(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.WebsitePageUpdateInput,
  ): Promise<WebsitePage> {
    return tx.websitePage.update({ where: { id }, data });
  }

  delete(tx: Prisma.TransactionClient, id: string): Promise<WebsitePage> {
    return tx.websitePage.delete({ where: { id } });
  }
}
