/** `WebsiteTestimonialEntry` response contract — matches `website-content.types.ts` field-for-field. */
import type { WebsiteTestimonialEntry as PrismaWebsiteTestimonialEntry } from '@prisma/client';
import type { LocalizedTextResponse } from './website-faq-entry.contract';

export interface WebsiteTestimonialEntryResponse {
  readonly id: string;
  readonly academyId: string;
  readonly quote: LocalizedTextResponse;
  readonly authorName: string;
  readonly authorRole?: LocalizedTextResponse;
  readonly avatar?: string;
  readonly order: number;
  readonly visible: boolean;
  readonly status: PrismaWebsiteTestimonialEntry['status'];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toWebsiteTestimonialEntryResponse(
  entry: PrismaWebsiteTestimonialEntry,
): WebsiteTestimonialEntryResponse {
  return {
    id: entry.id,
    academyId: entry.academyId,
    quote: entry.quote as unknown as LocalizedTextResponse,
    authorName: entry.authorName,
    authorRole:
      (entry.authorRole as unknown as LocalizedTextResponse | null) ?? undefined,
    avatar: entry.avatar ?? undefined,
    order: entry.order,
    visible: entry.visible,
    status: entry.status,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}
