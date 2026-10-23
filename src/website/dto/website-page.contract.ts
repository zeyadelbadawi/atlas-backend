/** `WebsitePage` response contract — matches `website.types.ts` field-for-field. The frontend has no separate list/detail shape (`getPages`/`getPage` both resolve to `WebsitePage`), so this one projection backs both. */
import type {
  WebsitePage as PrismaWebsitePage,
  WebsitePageVersion as PrismaWebsitePageVersion,
} from '@prisma/client';

export interface WebsitePageResponse {
  readonly id: string;
  readonly academyId: string;
  readonly pageType: PrismaWebsitePage['pageType'];
  readonly coreType?: PrismaWebsitePage['coreType'];
  readonly title: string;
  readonly slug: string;
  readonly visible: boolean;
  readonly seo: Record<string, unknown>;
  readonly sections: readonly unknown[];
  /** Optimistic-concurrency token — send it back on update to be told about a conflict instead of causing one. */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Management responses only: when this page was last published (absent = never). */
  readonly publishedAt?: string;
  /** Management responses only: the working copy differs from what visitors see. */
  readonly hasUnpublishedChanges?: boolean;
}

export function toWebsitePageResponse(page: PrismaWebsitePage): WebsitePageResponse {
  return {
    id: page.id,
    academyId: page.academyId,
    pageType: page.pageType,
    coreType: page.coreType ?? undefined,
    title: page.title,
    slug: page.slug,
    visible: page.visible,
    seo: page.seo as Record<string, unknown>,
    sections: page.sections as unknown[],
    version: page.version,
    createdAt: page.createdAt.toISOString(),
    updatedAt: page.updatedAt.toISOString(),
  };
}

/** The dashboard's view of a page: the working copy plus its publication state. Never used for public responses. */
export function toManagedWebsitePageResponse(
  page: PrismaWebsitePage,
): WebsitePageResponse {
  return {
    ...toWebsitePageResponse(page),
    publishedAt: page.publishedAt?.toISOString(),
    hasUnpublishedChanges: page.publishedVersion !== page.version,
  };
}

/**
 * CMS phase 4 — one entry of a page's history (`GET …/pages/:pageId/versions`).
 * `kind`: `published` (what went live at a publish), `draft_snapshot` (the
 * working copy before an editing session, at most one per 10 minutes) or
 * `restore_backup` (the working copy a restore replaced).
 */
export interface WebsitePageVersionSummaryResponse {
  readonly id: string;
  readonly pageId: string;
  readonly kind: PrismaWebsitePageVersion['kind'];
  readonly title: string;
  readonly slug: string;
  readonly visible: boolean;
  /** The page `version` this copy was taken from. */
  readonly sourceVersion: number;
  readonly createdAt: string;
  /** Who caused it; null when unknown or the account is gone. */
  readonly createdBy: { readonly id: string; readonly name: string } | null;
}

/** One version with its content (`GET …/versions/:versionId`), for a preview. */
export interface WebsitePageVersionResponse extends WebsitePageVersionSummaryResponse {
  readonly seo: Record<string, unknown>;
  readonly sections: readonly unknown[];
}

export function toWebsitePageVersionSummaryResponse(
  version: Omit<PrismaWebsitePageVersion, 'seo' | 'sections'> & {
    readonly createdByName: string | null;
  },
): WebsitePageVersionSummaryResponse {
  return {
    id: version.id,
    pageId: version.pageId,
    kind: version.kind,
    title: version.title,
    slug: version.slug,
    visible: version.visible,
    sourceVersion: version.sourceVersion,
    createdAt: version.createdAt.toISOString(),
    createdBy:
      version.createdById && version.createdByName !== null
        ? { id: version.createdById, name: version.createdByName }
        : null,
  };
}

export function toWebsitePageVersionResponse(
  version: PrismaWebsitePageVersion & { readonly createdBy: { name: string } | null },
): WebsitePageVersionResponse {
  return {
    ...toWebsitePageVersionSummaryResponse({
      ...version,
      createdByName: version.createdBy?.name ?? null,
    }),
    seo: version.seo as Record<string, unknown>,
    sections: version.sections as unknown[],
  };
}
