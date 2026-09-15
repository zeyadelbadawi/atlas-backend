/**
 * Body for PATCH platform-add-ons/:key/status.
 *
 * `catalogStatus` is the new authoritative publication state.
 * `expectedVersion` is the optimistic-concurrency token the client last
 * read — the write is refused with `stale_resource_version` if the row has
 * moved on since, exactly as every other versioned resource in this repo.
 */
import { IsIn, IsInt, Min } from 'class-validator';
import {
  ADD_ON_CATALOG_STATUSES,
  type AddOnCatalogStatusValue,
} from './platform-add-on-query.dto';

export class UpdateAddOnCatalogStatusDto {
  @IsIn(ADD_ON_CATALOG_STATUSES)
  readonly catalogStatus!: AddOnCatalogStatusValue;

  @IsInt()
  @Min(0)
  readonly expectedVersion!: number;
}
