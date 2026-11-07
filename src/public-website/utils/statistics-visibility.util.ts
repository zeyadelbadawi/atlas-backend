/**
 * B0-WEB-10 follow-up (B4 sweep) — the learner count is public only when the
 * academy chose to show it.
 *
 * `GET public/websites/:academyId/statistics` used to return the number of
 * active learners for every published academy, whatever its Statistics
 * section showed; the editor's "Students off by default" only hid it on the
 * page. Now `students` is returned only when an enabled Statistics section
 * on one of the academy's pages has an item with `metric: 'students'`.
 *
 * Only what visitors can see counts: the published sections of published,
 * visible pages (the public tenant context can read no other page, by RLS).
 * Until the owner publishes a Students item, the editor preview shows 0 for
 * it. Courses and instructors stay
 * public as before (they are listed on the site itself).
 */
export interface PageSectionsSource {
  readonly sections?: unknown;
  readonly publishedSections?: unknown;
}

function showsStudents(sections: unknown): boolean {
  if (!Array.isArray(sections)) return false;
  return sections.some((section) => {
    if (!section || typeof section !== 'object') return false;
    const s = section as { type?: unknown; enabled?: unknown; config?: unknown };
    if (s.type !== 'statistics' || s.enabled === false) return false;
    const items = (s.config as { items?: unknown } | null | undefined)?.items;
    return (
      Array.isArray(items) &&
      items.some(
        (item) =>
          !!item &&
          typeof item === 'object' &&
          (item as { metric?: unknown }).metric === 'students',
      )
    );
  });
}

/**
 * Whether any of the given pages shows the learner count. The caller passes
 * the published, visible pages (`findAllPublished`, whose rows carry the
 * published sections); both section fields are read so the check holds for
 * either row shape.
 */
export function academyShowsStudentCount(pages: readonly PageSectionsSource[]): boolean {
  return pages.some(
    (page) => showsStudents(page.sections) || showsStudents(page.publishedSections),
  );
}
