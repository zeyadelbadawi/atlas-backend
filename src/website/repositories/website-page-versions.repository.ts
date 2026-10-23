/**
 * WebsitePageVersionsRepository — CMS phase 4 page history. Same rules as
 * every other repository here: a `Prisma.TransactionClient` from
 * `TenancyContextService.runInTenantAndUserContext`, `academyId` always
 * explicit. Every insert prunes the page back to the newest
 * `WEBSITE_PAGE_VERSION_RETENTION` rows in the same transaction, so the
 * table can never grow past that per page.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  WebsitePage,
  WebsitePageVersion,
  WebsitePageVersionKind,
} from '@prisma/client';

/** Versions kept per page; older ones are pruned on insert. */
export const WEBSITE_PAGE_VERSION_RETENTION = 30;

/** A version without its content — what the history list shows. */
export type WebsitePageVersionSummary = Omit<WebsitePageVersion, 'seo' | 'sections'> & {
  readonly createdByName: string | null;
};

@Injectable()
export class WebsitePageVersionsRepository {
  /** Records `page`'s current editable content as a `kind` version, then prunes. */
  async record(
    tx: Prisma.TransactionClient,
    page: Pick<
      WebsitePage,
      'id' | 'academyId' | 'title' | 'slug' | 'visible' | 'seo' | 'sections' | 'version'
    >,
    kind: WebsitePageVersionKind,
    userId: string,
  ): Promise<void> {
    await tx.websitePageVersion.create({
      data: {
        academyId: page.academyId,
        pageId: page.id,
        kind,
        title: page.title,
        slug: page.slug,
        visible: page.visible,
        seo: page.seo as Prisma.InputJsonValue,
        sections: page.sections as Prisma.InputJsonValue,
        sourceVersion: page.version,
        createdById: userId,
      },
    });
    await this.prune(tx, page.academyId, page.id);
  }

  /**
   * A whole-site publish: one `published` version for every page whose
   * working copy is about to go live with changes (never published, or
   * edited since). Must run BEFORE the publish copies the working copies,
   * which is what makes `published_version = version` for every page.
   */
  async recordPublishedForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<void> {
    const inserted = await tx.$executeRaw`
      INSERT INTO "website_page_versions"
        ("id", "academy_id", "page_id", "kind", "title", "slug", "visible",
         "seo", "sections", "source_version", "created_by_id")
      SELECT gen_random_uuid()::text, p."academy_id", p."id", 'published',
             p."title", p."slug", p."visible", p."seo", p."sections",
             p."version", ${userId}
      FROM "website_pages" p
      WHERE p."academy_id" = ${academyId}
        AND p."published_version" IS DISTINCT FROM p."version"`;
    if (inserted > 0) await this.prune(tx, academyId);
  }

  /** Deletes all but the newest `WEBSITE_PAGE_VERSION_RETENTION` versions of one page, or of every page of the academy. */
  private async prune(
    tx: Prisma.TransactionClient,
    academyId: string,
    pageId?: string,
  ): Promise<void> {
    const pageFilter = pageId ? Prisma.sql`AND "page_id" = ${pageId}` : Prisma.empty;
    await tx.$executeRaw`
      DELETE FROM "website_page_versions"
      WHERE "id" IN (
        SELECT "id" FROM (
          SELECT "id", row_number() OVER (
            PARTITION BY "page_id" ORDER BY "created_at" DESC, "id" DESC
          ) AS "rank"
          FROM "website_page_versions"
          WHERE "academy_id" = ${academyId} ${pageFilter}
        ) ranked
        WHERE ranked."rank" > ${WEBSITE_PAGE_VERSION_RETENTION}
      )`;
  }

  /** The newest version of a page (optionally of one kind) — the cheap check behind the draft-snapshot throttle. */
  findLatest(
    tx: Prisma.TransactionClient,
    academyId: string,
    pageId: string,
    kind?: WebsitePageVersionKind,
  ): Promise<Pick<WebsitePageVersion, 'createdAt' | 'sourceVersion'> | null> {
    return tx.websitePageVersion.findFirst({
      where: { academyId, pageId, ...(kind ? { kind } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { createdAt: true, sourceVersion: true },
    });
  }

  /** Newest first, without the content columns. */
  async listForPage(
    tx: Prisma.TransactionClient,
    academyId: string,
    pageId: string,
  ): Promise<WebsitePageVersionSummary[]> {
    const rows = await tx.websitePageVersion.findMany({
      where: { academyId, pageId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        academyId: true,
        pageId: true,
        kind: true,
        title: true,
        slug: true,
        visible: true,
        sourceVersion: true,
        createdById: true,
        createdAt: true,
        createdBy: { select: { name: true } },
      },
    });
    return rows.map(({ createdBy, ...row }) => ({
      ...row,
      createdByName: createdBy?.name ?? null,
    }));
  }

  findById(
    tx: Prisma.TransactionClient,
    academyId: string,
    pageId: string,
    versionId: string,
  ): Promise<(WebsitePageVersion & { createdBy: { name: string } | null }) | null> {
    return tx.websitePageVersion.findFirst({
      where: { id: versionId, academyId, pageId },
      include: { createdBy: { select: { name: true } } },
    });
  }
}
