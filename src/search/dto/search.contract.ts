/**
 * `GET /search` response — matches `SearchResults`/`SearchResultGroup`/
 * `SearchResultItem` (`search.types.ts`) field-for-field. Every category
 * this backend can ever populate matches `SearchResultCategory`'s exact,
 * closed four-value union — never a fifth, invented category.
 */
export type SearchResultCategory = 'users' | 'platform' | 'content' | 'system';

export interface SearchResultItemResponse {
  readonly id: string;
  readonly category: SearchResultCategory;
  readonly title: string;
  readonly description?: string;
  readonly metadata?: Record<string, string>;
  readonly path?: string;
}

export interface SearchResultGroupResponse {
  readonly category: SearchResultCategory;
  readonly categoryLabelKey: string;
  readonly items: readonly SearchResultItemResponse[];
}

export interface SearchResultsResponse {
  readonly query: string;
  readonly groups: readonly SearchResultGroupResponse[];
  readonly totalCount: number;
}

export const CATEGORY_LABEL_KEYS: Record<SearchResultCategory, string> = {
  users: 'search:categories.users',
  platform: 'search:categories.platform',
  content: 'search:categories.content',
  system: 'search:categories.system',
};

/** Bounded per master plan §21 P17 ("bounded result counts... avoid unbounded result lists") — a global search box surfaces a handful of best matches, not an exhaustive listing (the frontend has no pagination UI for search results at all). */
export const MAX_RESULTS_PER_CATEGORY = 5;
