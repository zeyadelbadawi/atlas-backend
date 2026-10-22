/**
 * `GET academies/:id/contact-submissions` query — the shared collection
 * query (page, pageSize ≤ 100, search, sort) plus the filters the Owner's
 * Messages page offers: status and a received-date range.
 *
 * `search` matches name, email, message, phone or the chosen option
 * (case-insensitive). `kind` narrows to one form. `from`/`to`
 * are calendar dates (`YYYY-MM-DD`), inclusive, in UTC.
 */
import { IsIn, IsOptional, Matches, MaxLength } from 'class-validator';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';

export const CONTACT_SUBMISSION_SORT_FIELDS = ['createdAt', 'name', 'email'] as const;
export type ContactSubmissionSortField = (typeof CONTACT_SUBMISSION_SORT_FIELDS)[number];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ContactSubmissionQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsIn(['new', 'read', 'archived'])
  readonly status?: 'new' | 'read' | 'archived';

  /** CMS phase 3d (batch C) — only Contact form messages, or only "register your interest" submissions. */
  @IsOptional()
  @IsIn(['contact', 'interest'])
  readonly kind?: 'contact' | 'interest';

  @IsOptional()
  @Matches(ISO_DATE, { message: 'validation:date' })
  readonly from?: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'validation:date' })
  readonly to?: string;

  @IsOptional()
  @IsIn(CONTACT_SUBMISSION_SORT_FIELDS)
  declare readonly sortBy?: ContactSubmissionSortField;

  @IsOptional()
  @MaxLength(200)
  declare readonly search?: string;
}
