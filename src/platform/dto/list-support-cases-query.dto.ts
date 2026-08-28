/** `GET /support-cases` query — extends the shared `CollectionQueryDto` with the one filter `PlatformSupportListPage.tsx` actually sends (`filters: {status}}`, confirmed by reading the page directly) — no other filter is invented. */
import { IsIn, IsOptional } from 'class-validator';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import { SUPPORT_CASE_STATUSES } from './support.constants';
import type { SupportCaseStatus } from '@prisma/client';

export class ListSupportCasesQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsIn(SUPPORT_CASE_STATUSES)
  readonly status?: SupportCaseStatus;
}
