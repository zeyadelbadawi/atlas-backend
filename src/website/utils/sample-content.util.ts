/**
 * Sample social proof (Theme 1 plan §D.4, Decision 2).
 *
 * Starter testimonials are marked `sample: true`: they exist for preview
 * and design only. This is the backend's half of the rule:
 *   - `stripSampleContent` — applied to the PUBLIC pages payload before it
 *     is cached, so a sample item never reaches a visitor's browser, even
 *     with a modified client (defence in depth; the renderer filters too);
 *   - `collectSampleContent` — what the publish response (and the
 *     dashboard's publish dialog, via the frontend mirror) warns about.
 * Statistics and instructors are always live data, so only the sections
 * whose items are authored claims carry the flag: testimonials, and (CMS
 * phase 3d) student results and the class schedule — a starter timetable
 * or a starter "top student" on the live site would be invented facts.
 */

/** The section types whose `items` may hold `sample: true` starter items. */
export const SAMPLE_ITEM_SECTION_TYPES: readonly string[] = [
  'testimonials',
  'results',
  'schedule',
  // CMS phase 3d (batch D) — a starter video review is an invented one.
  'videoTestimonials',
];

interface SectionLike {
  readonly id: string;
  readonly type: string;
  readonly config?: unknown;
}

interface PageLike {
  readonly id: string;
  readonly title: string;
  readonly sections: readonly unknown[];
}

export interface SampleContentEntry {
  readonly pageId: string;
  readonly pageTitle: string;
  readonly sectionId: string;
  readonly sectionType: string;
  readonly sampleItems: number;
}

function sampleItemCount(section: SectionLike | null | undefined): number {
  if (!section || !SAMPLE_ITEM_SECTION_TYPES.includes(section.type)) return 0;
  const items = (section.config as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) return 0;
  return items.filter((item) => (item as { sample?: unknown } | null)?.sample === true)
    .length;
}

/** The same sections with every `sample: true` item (testimonial, result, schedule row, video review) removed. Other sections are returned as-is (same object). */
export function stripSampleContent(sections: readonly unknown[]): unknown[] {
  return sections.map((raw) => {
    const section = raw as SectionLike;
    if (sampleItemCount(section) === 0) return raw;
    const config = section.config as { items: unknown[] };
    return {
      ...section,
      config: {
        ...config,
        items: config.items.filter(
          (item) => (item as { sample?: unknown } | null)?.sample !== true,
        ),
      },
    };
  });
}

/** Every section, on every page, that still holds sample items — in page and section order. */
export function collectSampleContent(pages: readonly PageLike[]): SampleContentEntry[] {
  const entries: SampleContentEntry[] = [];
  for (const page of pages) {
    for (const raw of page.sections) {
      const section = raw as SectionLike;
      const sampleItems = sampleItemCount(section);
      if (sampleItems > 0) {
        entries.push({
          pageId: page.id,
          pageTitle: page.title,
          sectionId: section.id,
          sectionType: section.type,
          sampleItems,
        });
      }
    }
  }
  return entries;
}
