/**
 * Query-string contracts shared by every paginated list endpoint — matches
 * `CollectionQuery`'s wire shape (`toCollectionParams`,
 * `atlas frontend/src/services/api/request.utils.ts`): flat `page`,
 * `pageSize`, `sortBy`, `sortDirection`, `search` params. The global
 * `ValidationPipe` runs with `forbidNonWhitelisted: true`, so every query
 * key a caller might send must be declared here, not just documented.
 *
 * Originally introduced in `src/academy/` (P3), moved here in P5 when
 * `src/course/` needed the identical base fields — same "one shared
 * definition, not three near-identical copies" reasoning as
 * `common/dto/pagination.contract.ts`.
 */
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export class CollectionQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  readonly page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  readonly pageSize?: number;

  @IsOptional()
  @IsString()
  readonly sortBy?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  readonly sortDirection?: 'asc' | 'desc';

  @IsOptional()
  @IsString()
  readonly search?: string;
}
