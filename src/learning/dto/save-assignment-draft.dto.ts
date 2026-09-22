import { IsOptional, IsString, MaxLength } from 'class-validator';
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
}
