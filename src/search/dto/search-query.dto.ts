/**
 * `GET /search?q=` query — matches `SearchService.search(query)`
 * (frontend), which always sends a single `q` param. Bounded length
 * (master plan §21 P17: "Set a reasonable maximum query length") — a
 * search box has no legitimate reason to submit a multi-kilobyte string,
 * and an unbounded value would otherwise reach `websearch_to_tsquery`
 * directly.
 */
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export const MAX_SEARCH_QUERY_LENGTH = 200;
/** Matches `useGlobalSearch`'s own client-side `MIN_QUERY_LENGTH` (frontend) exactly — enforced again here since the client-side gate is defense-in-depth only, never the real boundary. */
export const MIN_SEARCH_QUERY_LENGTH = 2;

export class SearchQueryDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'errors.search.emptyQuery' })
  @MinLength(MIN_SEARCH_QUERY_LENGTH, { message: 'errors.search.queryTooShort' })
  @MaxLength(MAX_SEARCH_QUERY_LENGTH, { message: 'errors.search.queryTooLong' })
  readonly q!: string;
}
