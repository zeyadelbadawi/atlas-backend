/**
 * Query-string contracts for `GET /academies*` list endpoints — matches
 * `CollectionQuery`'s wire shape (`toCollectionParams`,
 * `atlas frontend/src/services/api/request.utils.ts`): flat `page`,
 * `pageSize`, `sortBy`, `sortDirection`, `search` params. The global
 * `ValidationPipe` runs with `forbidNonWhitelisted: true`, so every query
 * key a caller might send must be declared here, not just documented.
 */
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';

export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** Shared by every sub-resource list (`members`, `activity`) — the academy id already scopes these via the route param. */
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

/** `GET /academies` — see `CreateAcademyDto`'s doc comment for why `organizationId` is a required explicit field here too. */
export class ListAcademiesQueryDto extends CollectionQueryDto {
  @IsNotEmpty()
  @IsString()
  readonly organizationId!: string;
}
