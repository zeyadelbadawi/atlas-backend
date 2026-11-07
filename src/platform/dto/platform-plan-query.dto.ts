import { IsIn, IsOptional, MaxLength } from 'class-validator';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';

/**
 * Item 9 (plan management) — which plans the Platform Owner list shows.
 *
 * - `listed`: offered to customers (`status: 'active'`, `displayOrder > 0`,
 *   the customer catalog's own filter).
 * - `hidden`: active but not offered (`displayOrder: 0`): buyable by key
 *   only, which is where a new plan starts.
 * - `archived`: closed (`status: 'archived'`).
 *
 * Omitted, every plan is listed. `search` matches the key or the name.
 */
export const PLATFORM_PLAN_VISIBILITIES = ['listed', 'hidden', 'archived'] as const;
export type PlatformPlanVisibility = (typeof PLATFORM_PLAN_VISIBILITIES)[number];

export class PlatformPlanQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsIn(PLATFORM_PLAN_VISIBILITIES)
  readonly visibility?: PlatformPlanVisibility;

  @IsOptional()
  @MaxLength(100)
  declare readonly search?: string;
}
