/**
 * `GET platform/contact-submissions` query — the shared collection query
 * (page, pageSize ≤ 100, search, sort) plus the inbox filters: status,
 * topic and a received-date range.
 *
 * `search` matches name, email, organization or message (case-insensitive).
 * `from`/`to` are calendar dates (`YYYY-MM-DD`), inclusive, in UTC — the
 * same contract as the academy Messages page.
 */
import { IsIn, IsOptional, Matches, MaxLength } from 'class-validator';
import type {
  PlatformContactSubmissionStatus,
  PlatformContactTopic,
} from '@prisma/client';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import {
  PLATFORM_CONTACT_STATUSES,
  PLATFORM_CONTACT_TOPICS,
} from '../platform-contact.constants';

export const PLATFORM_CONTACT_SORT_FIELDS = ['createdAt', 'name', 'email'] as const;
export type PlatformContactSortField = (typeof PLATFORM_CONTACT_SORT_FIELDS)[number];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ListPlatformContactSubmissionsQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsIn(PLATFORM_CONTACT_STATUSES)
  readonly status?: PlatformContactSubmissionStatus;

  @IsOptional()
  @IsIn(PLATFORM_CONTACT_TOPICS)
  readonly topic?: PlatformContactTopic;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'validation:date' })
  readonly from?: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'validation:date' })
  readonly to?: string;

  @IsOptional()
  @IsIn(PLATFORM_CONTACT_SORT_FIELDS)
  declare readonly sortBy?: PlatformContactSortField;

  @IsOptional()
  @MaxLength(200)
  declare readonly search?: string;
}
