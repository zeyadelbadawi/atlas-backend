/**
 * `PATCH platform/customer-requests/:id` — a status move and/or an
 * assignment. `note`, when given with a status move, is posted as a
 * customer-visible message alongside it (e.g. why a request was declined).
 */
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import type { CustomerRequestStatus } from '@prisma/client';
import { CUSTOMER_REQUEST_STATUSES } from '../customer-requests.constants';

export class UpdateCustomerRequestDto {
  @IsOptional()
  @IsIn(CUSTOMER_REQUEST_STATUSES)
  readonly status?: CustomerRequestStatus;

  /** A Platform Owner's user id, or `null` to unassign. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  readonly assigneeUserId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  readonly note?: string;
}
