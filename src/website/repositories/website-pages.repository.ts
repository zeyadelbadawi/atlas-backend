/**
 * WebsitePagesRepository — every method takes a `Prisma.TransactionClient`
 * obtained from `TenancyContextService.runInTenantContext`, matching every
 * other repository in this codebase's established rule. `academyId` is
 * always explicit, never inferred (master plan §24).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { WebsiteCorePageType, WebsitePage } from '@prisma/client';

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
  async findAllPublished(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<WebsitePage[]> {
    const rows = await tx.websitePage.findMany({
      where: {
        academyId,
        publishedVisible: true,
        publishedSections: { not: Prisma.DbNull },
      },
    });
    return rows.map(asPublishedPage);
  }

  /** The public runtime's single-page eligibility query — same `visible: true` WHERE-clause discipline as `findAllPublished`. `null` for a hidden page exactly the same way as a nonexistent slug — see that method's own doc comment. */
  async findPublishedBySlug(
    tx: Prisma.TransactionClient,
    academyId: string,
    slug: string,
  ): Promise<WebsitePage | null> {
    const row = await tx.websitePage.findFirst({
      where: {
        academyId,
        publishedSlug: slug,
        publishedVisible: true,
        publishedSections: { not: Prisma.DbNull },
      },
    });
    return row ? asPublishedPage(row) : null;
  }

  /**
   * Publish one page, or (no `pageId`) every page of the Academy: copy the
   * working copy into the published columns in one statement.
   */
  /**
   * Copies the working copy into the published columns — every page of the
   * Academy, or one page. For one page, `expected` pins the slug and version
   * the caller checked: an edit saved in between makes this a no-op (0),
   * never a publish of something nobody checked.
   */
  async publish(
    tx: Prisma.TransactionClient,
    academyId: string,
    page?: { readonly id: string; readonly slug: string; readonly version: number },
  ): Promise<number> {
    return page
      ? tx.$executeRaw`
          UPDATE "website_pages" SET
            "published_title" = "title", "published_slug" = "slug",
            "published_visible" = "visible", "published_seo" = "seo",
            "published_sections" = "sections", "published_version" = "version",
            "published_at" = CURRENT_TIMESTAMP
          WHERE "academy_id" = ${academyId} AND "id" = ${page.id}
            AND "slug" = ${page.slug} AND "version" = ${page.version}`
      : tx.$executeRaw`
          UPDATE "website_pages" SET
            "published_title" = "title", "published_slug" = "slug",
            "published_visible" = "visible", "published_seo" = "seo",
            "published_sections" = "sections", "published_version" = "version",
            "published_at" = CURRENT_TIMESTAMP
          WHERE "academy_id" = ${academyId}`;
  }

  /**
   * Another page already live at `slug`. Draft slugs are unique, published
   * ones are only unique if pages are published together — renaming page A
   * away from a slug and giving it to page B, then publishing only B, would
   * otherwise put two live pages on one address.
   */
  findPublishedSlugClash(
    tx: Prisma.TransactionClient,
    academyId: string,
    pageId: string,
    slug: string,
  ): Promise<{ id: string; title: string } | null> {
    return tx.websitePage.findFirst({
      where: { academyId, id: { not: pageId }, publishedSlug: slug },
      select: { id: true, title: true },
    });
  }

  /** Pages whose working copy differs from what is published. */
  countWithUnpublishedChanges(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<number> {
    return tx.websitePage
      .findMany({
        where: { academyId },
        select: { version: true, publishedVersion: true },
      })
      .then((rows) => rows.filter((row) => row.publishedVersion !== row.version).length);
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

  /**
   * The same update, but only if the row is still at `expectedVersion`.
   *
   * WHY A SEPARATE METHOD RATHER THAN A CHECK IN THE SERVICE. The service
   * does read the version first, and that read is what produces a useful
   * error message. But a read followed by a write is two statements, and
   * between them another transaction can commit — the classic
   * check-then-act race, which is exactly the bug this whole mechanism
   * exists to prevent. Putting `version` in the WHERE clause makes the
   * database itself the arbiter: at most one of two concurrent savers can
   * match, and the loser updates zero rows.
   *
   * `updateMany` rather than `update` deliberately: `update` throws `P2025`
   * for a non-match, which is indistinguishable from "the page was
   * deleted". A count of zero is unambiguous, and the caller turns it into
   * the same conflict the pre-check would have raised.
   */
  async updateIfVersionMatches(
    tx: Prisma.TransactionClient,
    id: string,
    expectedVersion: number,
    data: Prisma.WebsitePageUncheckedUpdateInput,
  ): Promise<WebsitePage | null> {
    const result = await tx.websitePage.updateMany({
      where: { id, version: expectedVersion },
      data,
    });
    if (result.count === 0) return null;
    return tx.websitePage.findUniqueOrThrow({ where: { id } });
  }

  delete(tx: Prisma.TransactionClient, id: string): Promise<WebsitePage> {
    return tx.websitePage.delete({ where: { id } });
  }
}

/** The page as the public sees it: its published copy in place of the working copy. */
export function asPublishedPage(row: WebsitePage): WebsitePage {
  return {
    ...row,
    title: row.publishedTitle ?? row.title,
    slug: row.publishedSlug ?? row.slug,
    visible: row.publishedVisible ?? false,
    seo: (row.publishedSeo ?? row.seo) as Prisma.JsonValue,
    sections: (row.publishedSections ?? row.sections) as Prisma.JsonValue,
  };
}
