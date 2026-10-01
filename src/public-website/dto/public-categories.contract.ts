/**
 * `GET public/websites/:academyId/categories` (Theme 1 plan §D.2) — the
 * Academy's course categories that hold at least one published, public
 * course, with that count. Public fields only: no internal ids beyond the
 * category's own (used for the catalog's `categoryId` filter), no
 * timestamps, no counts of drafts or private courses.
 */
export interface PublicCourseCategoryResponse {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description?: string;
  readonly courseCount: number;
}
