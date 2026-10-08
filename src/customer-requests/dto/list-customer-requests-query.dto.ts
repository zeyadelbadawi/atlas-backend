/**
 * Request lists: the shared collection query plus type/status filters,
 * and (platform only) academy and assignee filters. `search` matches the
 * title, and for the platform also the academy name and requester.
 */
import { IsIn, IsOptional, IsUUID, MaxLength } from 'class-validator';
import type { CustomerRequestStatus, CustomerRequestType } from '@prisma/client';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import {
  CUSTOMER_REQUEST_STATUSES,
  CUSTOMER_REQUEST_TYPES,
} from '../customer-requests.constants';

export const CUSTOMER_REQUEST_SORT_FIELDS = [
  'lastActivityAt',
  'createdAt',
  'title',
] as const;
export type CustomerRequestSortField = (typeof CUSTOMER_REQUEST_SORT_FIELDS)[number];

export class ListCustomerRequestsQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsIn(CUSTOMER_REQUEST_TYPES)
  readonly type?: CustomerRequestType;

  /** One status, or `open` for every status that is not closed. */
  @IsOptional()
  @IsIn([...CUSTOMER_REQUEST_STATUSES, 'open'])
  readonly status?: CustomerRequestStatus | 'open';

  @IsOptional()
  @IsIn(CUSTOMER_REQUEST_SORT_FIELDS)
  declare readonly sortBy?: CustomerRequestSortField;

  @IsOptional()
  @MaxLength(200)
  declare readonly search?: string;
}

export class ListPlatformCustomerRequestsQueryDto extends ListCustomerRequestsQueryDto {
  @IsOptional()
  @IsUUID()
  readonly academyId?: string;

  /** A Platform Owner's id, or `unassigned`. */
  @IsOptional()
  @MaxLength(64)
  readonly assigneeUserId?: string;
}
