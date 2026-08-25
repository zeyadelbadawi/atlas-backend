/** `WebsiteFaqEntry` response contract — matches `website-content.types.ts` field-for-field. */
import type { WebsiteFaqEntry as PrismaWebsiteFaqEntry } from '@prisma/client';

export interface LocalizedTextResponse {
  readonly en: string;
  readonly ar: string;
}

export interface WebsiteFaqEntryResponse {
  readonly id: string;
  readonly academyId: string;
  readonly question: LocalizedTextResponse;
  readonly answer: LocalizedTextResponse;
  readonly order: number;
  readonly visible: boolean;
  readonly status: PrismaWebsiteFaqEntry['status'];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toWebsiteFaqEntryResponse(
  entry: PrismaWebsiteFaqEntry,
): WebsiteFaqEntryResponse {
  return {
    id: entry.id,
    academyId: entry.academyId,
    question: entry.question as unknown as LocalizedTextResponse,
    answer: entry.answer as unknown as LocalizedTextResponse,
    order: entry.order,
    visible: entry.visible,
    status: entry.status,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}
