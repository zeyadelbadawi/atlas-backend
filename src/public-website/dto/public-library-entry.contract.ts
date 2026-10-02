/**
 * What a public page carries for a section's content-library entries
 * (`libraryEntryIds` → `libraryEntries`, expanded by
 * `PublicWebsiteService`). Exactly the fields a visitor sees — never the
 * entry's status, visibility, order, timestamps or Academy id.
 */
import type { Prisma, WebsiteFaqEntry, WebsiteTestimonialEntry } from '@prisma/client';

export interface PublicFaqLibraryEntry {
  readonly id: string;
  readonly question: Prisma.JsonValue;
  readonly answer: Prisma.JsonValue;
}

export interface PublicTestimonialLibraryEntry {
  readonly id: string;
  readonly quote: Prisma.JsonValue;
  readonly authorName: string;
  readonly authorRole?: Prisma.JsonValue;
  readonly avatar?: string;
}

export function toPublicFaqLibraryEntry(entry: WebsiteFaqEntry): PublicFaqLibraryEntry {
  return { id: entry.id, question: entry.question, answer: entry.answer };
}

export function toPublicTestimonialLibraryEntry(
  entry: WebsiteTestimonialEntry,
): PublicTestimonialLibraryEntry {
  return {
    id: entry.id,
    quote: entry.quote,
    authorName: entry.authorName,
    ...(entry.authorRole !== null ? { authorRole: entry.authorRole } : {}),
    ...(entry.avatar ? { avatar: entry.avatar } : {}),
  };
}
