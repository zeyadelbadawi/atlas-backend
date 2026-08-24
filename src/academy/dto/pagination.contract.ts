/**
 * `PaginatedResult<T>` — matches `atlas frontend/src/types/api.types.ts`
 * exactly: `{ items, pagination: { page, pageSize, totalItems, totalPages } }`.
 * This is the first backend module to paginate anything (P0/P1/P2 have no
 * list endpoints), so this helper is new, not a reuse of an existing one.
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
