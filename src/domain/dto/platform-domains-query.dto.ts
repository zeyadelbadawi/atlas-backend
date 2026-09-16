/**
 * Query for the Platform Owner's cross-tenant domain list (P63).
 * Extends the shared `CollectionQueryDto` (page/pageSize/search/sort) with
 * the three filters the console offers. `sortBy` is an `@IsIn` allow-list
 * because it is interpolated into a Prisma `orderBy` — the same rule every
 * other collection endpoint follows. Global `forbidNonWhitelisted` turns
 * any other key into a 400.
 */
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import { DOMAIN_STATUS_VALUES } from '../constants/domain.constants';
import type { DomainStatus } from '@prisma/client';

export const PLATFORM_DOMAINS_SORT_FIELDS = [
  'name',
  'createdAt',
  'hostname',
  'lastCheckedAt',
  'organization',
] as const;
export type PlatformDomainsSortField = (typeof PLATFORM_DOMAINS_SORT_FIELDS)[number];

export class PlatformDomainsQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsIn(PLATFORM_DOMAINS_SORT_FIELDS as unknown as string[])
  declare readonly sortBy?: PlatformDomainsSortField;

  @IsOptional()
  @IsIn(['custom', 'subdomain'])
  readonly kind?: 'custom' | 'subdomain';

  @IsOptional()
  @IsIn(DOMAIN_STATUS_VALUES)
  readonly status?: DomainStatus;

  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  readonly attention?: boolean;
}
