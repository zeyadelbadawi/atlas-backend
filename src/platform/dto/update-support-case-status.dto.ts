/** `PATCH /support-cases/:id/status` request — matches `UpdateSupportCaseStatusPayload` (atlas frontend `support.types.ts`) exactly: the standard, universally-understood lifecycle, never an invented workflow. */
import { IsIn, IsNotEmpty } from 'class-validator';
import { SUPPORT_CASE_STATUSES } from './support.constants';

export class UpdateSupportCaseStatusDto {
  @IsNotEmpty()
  @IsIn(SUPPORT_CASE_STATUSES, { message: 'errors.support.invalidStatus' })
  readonly status!: (typeof SUPPORT_CASE_STATUSES)[number];
}
