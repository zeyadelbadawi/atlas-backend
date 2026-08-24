/**
 * `PaginatedResult<T>` — matches `atlas frontend/src/types/api.types.ts`
 * exactly: `{ items, pagination: { page, pageSize, totalItems, totalPages } }`.
 *
 * Originally introduced in `src/academy/` (P3, the first backend module to
 * paginate anything — P0/P1/P2 have no list endpoints), and moved here in
 * P5 when `src/course/` needed the identical helper: three near-identical
 * copies across `academy`/`plans`/`course` would have been the exact
 * "duplicated" drift the CTO audit checklist flags, for a pure,
 * behaviorless utility type with zero reason to differ per module. Every
 * paginated response in this codebase now shares this one definition.
 */
export interface PaginationMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
}

export interface PaginatedResult<T> {
  readonly items: readonly T[];
  readonly pagination: PaginationMeta;
}

export function buildPaginationMeta(
  page: number,
  pageSize: number,
  totalItems: number,
): PaginationMeta {
  return {
    page,
    pageSize,
    totalItems,
    totalPages: Math.max(Math.ceil(totalItems / pageSize), 1),
  };
}
