/**
 * Wire shapes for the Platform Owner Add-ons Management surface.
 *
 * One row per registered add-on — the catalog is small and fixed by the
 * add-on registry, so this list is never a firehose. Every field is drawn
 * from a real row: `catalogStatus`/`version`/`updatedAt` from `add_ons`,
 * the two counts aggregated from `tenant_add_ons`. Nothing is invented for
 * a dashboard card, and no secret is carried.
 */
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import type { AddOnCatalogStatusValue } from './platform-add-on-query.dto';
import type { PlanPricingMetadataResponse } from '../../plans/dto/plan.contract';

export interface PlatformAddOnRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  /** B5 (UX audit) V21 — the Arabic name and description shown in the Arabic store; `null` = the English one is shown. */
  readonly nameAr: string | null;
  readonly descriptionAr: string | null;
  readonly catalogStatus: AddOnCatalogStatusValue;
  /** Plan management (item 9) — the price for new purchases; `null` = not priced (free to install). */
  readonly pricing: PlanPricingMetadataResponse | null;
  /** Academies that currently have this add-on installed (any non-uninstalled row). */
  readonly installCount: number;
  /** Academies that currently have this add-on enabled (its effect is live). */
  readonly enabledCount: number;
  /** Optimistic-concurrency token — echoed back on a status change. */
  readonly version: number;
  readonly updatedAt: string;
}

export type PlatformAddOnListResponse = PaginatedResult<PlatformAddOnRow>;
