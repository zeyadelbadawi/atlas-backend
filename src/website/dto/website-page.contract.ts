/** `WebsitePage` response contract — matches `website.types.ts` field-for-field. The frontend has no separate list/detail shape (`getPages`/`getPage` both resolve to `WebsitePage`), so this one projection backs both. */
import type { WebsitePage as PrismaWebsitePage } from '@prisma/client';

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
