import { IsISO8601, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { MAX_ASSIGNMENT_RESPONSE_LENGTH } from './learning.constants';

/** P64 Phase 3 (§D.4) — draft autosave. `attachmentAssetId: null` detaches. */
export class SaveAssignmentDraftDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_ASSIGNMENT_RESPONSE_LENGTH)
  readonly response?: string;

  @IsOptional()
  @IsString()
  readonly attachmentAssetId?: string | null;

  /**
   * Academy offline work — compare-and-set. The `draftSavedAt` the client's
   * text was based on (`null` = it started from no draft). When the stored
   * draft has moved on since (another tab or device saved), the save is
   * refused with 409 `errors.assignment.draftConflict` carrying the newer
   * draft, instead of silently overwriting it. Omitted → last write wins,
   * as before.
   */
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsISO8601({ strict: true })
  readonly baseDraftSavedAt?: string | null;
}
