/**
 * `GET /notifications` query — extends `CollectionQueryDto` with the
 * flattened `filters` fields `NotificationFilters` (`notifications.
 * types.ts`) defines (`toCollectionParams` flattens `query.filters` to
 * top-level query params — see that frontend util's own doc comment),
 * matching `ListSupportCasesQueryDto`'s (P15) identical established
 * pattern for a list endpoint with a small, closed filter set.
 */
import { IsBooleanString, IsIn, IsOptional } from 'class-validator';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import { NOTIFICATION_PRIORITIES, NOTIFICATION_TYPES } from './notification.contract';

export class ListNotificationsQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsIn(NOTIFICATION_TYPES)
  readonly type?: (typeof NOTIFICATION_TYPES)[number];

  @IsOptional()
  @IsIn(NOTIFICATION_PRIORITIES)
  readonly priority?: (typeof NOTIFICATION_PRIORITIES)[number];

  // A query-string boolean arrives as the literal string `"true"`/`"false"`
  // (`isRead=false`) — no boolean filter exists anywhere else in this
  // codebase's list endpoints yet, so this is P17's own, deliberately
  // safe choice: `@IsBooleanString` validates the shape, the service
  // layer does an explicit `=== 'true'` string comparison — never
  // `@Type(() => Boolean)`/`Boolean(value)`, which coerces the non-empty
  // string `'false'` to `true`.
  @IsOptional()
  @IsBooleanString()
  readonly isRead?: string;
}
