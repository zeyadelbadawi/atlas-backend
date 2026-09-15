/**
 * Query contract for the Platform Owner Add-ons Management list.
 *
 * Reuses `CollectionQueryDto` (page/pageSize/sortBy/sortDirection/search)
 * exactly like every other paginated Platform surface, and adds the one
 * field this list needs beyond it: a catalog-status filter. Declared here
 * because the global `ValidationPipe` runs with `forbidNonWhitelisted`, so
 * an undeclared query key is a 400, not a silent ignore.
 */
import { IsIn, IsOptional } from 'class-validator';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';

/** The three authoritative catalog states, as accepted on the wire. */
export const ADD_ON_CATALOG_STATUSES = ['draft', 'coming_soon', 'published'] as const;
export type AddOnCatalogStatusValue = (typeof ADD_ON_CATALOG_STATUSES)[number];

export class PlatformAddOnQueryDto extends CollectionQueryDto {
  /** Narrow the list to one catalog state. Omitted means "all states". */
  @IsOptional()
  @IsIn(ADD_ON_CATALOG_STATUSES)
  readonly status?: AddOnCatalogStatusValue;
}
