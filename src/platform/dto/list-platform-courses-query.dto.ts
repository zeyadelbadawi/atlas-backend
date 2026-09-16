/**
 * Query contract for `GET /platform-courses` (P60).
 *
 * The global `ValidationPipe` runs `forbidNonWhitelisted: true`, so every
 * filter the console can send has to be declared here — an undeclared key
 * is a 400, not a silently ignored parameter.
 *
 * `sortBy` is an `@IsIn` allow-list rather than a free string because the
 * value is interpolated into a Prisma `orderBy` key. The four values are
 * exactly the sortable columns the list renders.
 */
import { IsIn, IsOptional, IsString } from 'class-validator';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';

export const PLATFORM_COURSE_SORT_FIELDS = [
  'title',
  'createdAt',
  'updatedAt',
  'publishedAt',
] as const;

export type PlatformCourseSortField = (typeof PLATFORM_COURSE_SORT_FIELDS)[number];

export class ListPlatformCoursesQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsIn(['draft', 'published', 'archived'])
  readonly status?: 'draft' | 'published' | 'archived';

  @IsOptional()
  @IsIn(['public', 'private'])
  readonly visibility?: 'public' | 'private';

  @IsOptional()
  @IsIn(['free', 'paid'])
  readonly pricingType?: 'free' | 'paid';

  @IsOptional()
  @IsString()
  readonly academyId?: string;

  @IsOptional()
  @IsString()
  readonly organizationId?: string;

  @IsOptional()
  @IsIn(PLATFORM_COURSE_SORT_FIELDS as unknown as string[])
  declare readonly sortBy?: PlatformCourseSortField;
}
