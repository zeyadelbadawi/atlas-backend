import { IsIn, IsOptional } from 'class-validator';
import type { PrivacyRequestStatus, PrivacyRequestType } from '@prisma/client';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import {
  PRIVACY_REQUEST_STATUSES,
  PRIVACY_REQUEST_TYPES,
} from '../privacy-requests.constants';

export class ListPrivacyRequestsQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsIn(PRIVACY_REQUEST_STATUSES)
  readonly status?: PrivacyRequestStatus;

  @IsOptional()
  @IsIn(PRIVACY_REQUEST_TYPES)
  readonly type?: PrivacyRequestType;
}
