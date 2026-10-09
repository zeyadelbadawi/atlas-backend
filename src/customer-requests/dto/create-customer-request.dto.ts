/**
 * `POST academies/:id/customer-requests`.
 *
 * `details` is the type's contextual fields (`CUSTOMER_REQUEST_DETAIL_FIELDS`);
 * its keys and bounds are checked per type by the service, because the
 * allowed set depends on `type`. `clientRequestId` makes a retried submit
 * (a double click, a retry after a dropped connection) return the request
 * it already created instead of filing a second one.
 */
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import type { CustomerRequestPriority, CustomerRequestType } from '@prisma/client';
import { CUSTOMER_REQUEST_TYPES } from '../customer-requests.constants';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateCustomerRequestDto {
  @IsIn(CUSTOMER_REQUEST_TYPES)
  readonly type!: CustomerRequestType;

  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(160)
  readonly title!: string;

  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(5000)
  readonly description!: string;

  @IsOptional()
  @IsIn(['low', 'normal', 'high'])
  readonly priority?: CustomerRequestPriority;

  @IsOptional()
  @IsObject()
  readonly details?: Record<string, unknown>;

  @IsUUID()
  readonly clientRequestId!: string;
}
