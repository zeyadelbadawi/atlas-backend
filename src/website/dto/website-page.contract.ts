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
    createdAt: page.createdAt.toISOString(),
    updatedAt: page.updatedAt.toISOString(),
  };
}
