/** `PUT platform/customer-request-routing` — the whole table at once. */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import type { CustomerRequestType } from '@prisma/client';
import { CUSTOMER_REQUEST_TYPES } from '../customer-requests.constants';

export class RoutingRuleDto {
  @IsIn(CUSTOMER_REQUEST_TYPES)
  readonly type!: CustomerRequestType;

  /** Empty / absent → no team inbox for this type (Platform Owners are emailed instead). */
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  readonly email?: string | null;
}

export class UpdateRoutingRulesDto {
  @IsArray()
  @ArrayMaxSize(CUSTOMER_REQUEST_TYPES.length)
  @ValidateNested({ each: true })
  @Type(() => RoutingRuleDto)
  readonly rules!: RoutingRuleDto[];
}
