/**
 * Content-library expansion for the PUBLIC pages payload.
 *
 * A `faq` or `testimonials` section can reference Academy-wide library
 * entries by id (`config.libraryEntryIds`). The public site has no access
 * to the management API, so the entries are resolved here, server-side,
 * into `config.libraryEntries` — in the order the Owner picked them, and
 * only the ones the repository returned (published, visible, this
 * Academy). An id that resolves to nothing is dropped silently: the page
 * still renders, without that entry. `libraryEntryIds` itself is kept so
 * the public payload stays a superset of the stored config.
 */
import type {
  PublicFaqLibraryEntry,
  PublicTestimonialLibraryEntry,
} from '../dto/public-library-entry.contract';

interface SectionLike {
  readonly type?: unknown;
  readonly config?: unknown;
}

export interface LibraryEntryIds {
  readonly faq: readonly string[];
  readonly testimonials: readonly string[];
}

function referencedIds(section: SectionLike): readonly string[] {
  const ids = (section.config as { libraryEntryIds?: unknown } | undefined)?.libraryEntryIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

/** Every distinct library id referenced by `faq` and by `testimonials` sections, across all pages. */
export function collectLibraryEntryIds(
  pages: readonly { readonly sections: readonly unknown[] }[],
): LibraryEntryIds {
  const faq = new Set<string>();
  const testimonials = new Set<string>();
  for (const page of pages) {
    for (const raw of page.sections) {
      const section = raw as SectionLike;
      if (section?.type === 'faq') referencedIds(section).forEach((id) => faq.add(id));
      if (section?.type === 'testimonials')
        referencedIds(section).forEach((id) => testimonials.add(id));
    }
  }
  return { faq: [...faq], testimonials: [...testimonials] };
}

/**
 * The same sections, each `faq`/`testimonials` section that references the
 * library carrying `config.libraryEntries` (resolved, ordered). Sections
 * without references are returned as-is (same object).
 */
export function expandLibraryEntries(
  sections: readonly unknown[],
  faqById: ReadonlyMap<string, PublicFaqLibraryEntry>,
  testimonialById: ReadonlyMap<string, PublicTestimonialLibraryEntry>,
): unknown[] {
  return sections.map((raw) => {
    const section = raw as SectionLike;
    const byId =
      section?.type === 'faq'
        ? faqById
        : section?.type === 'testimonials'
          ? testimonialById
          : null;
    if (!byId) return raw;
    const ids = referencedIds(section);
    if (ids.length === 0) return raw;
    // A repeated id is shown once (first position wins).
    const libraryEntries = [...new Set(ids)].flatMap((id) => {
      const entry = byId.get(id);
      return entry ? [entry] : [];
    });
    return {
      ...(raw as object),
      config: { ...(section.config as object), libraryEntries },
    };
  });
}
