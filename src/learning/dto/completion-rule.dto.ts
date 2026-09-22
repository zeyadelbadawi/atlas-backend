import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * P64 Phase 3 (AD-11) — staff update of a course's completion rule and its
 * certificate settings. `requiredQuizIds`/`requiredAssignmentIds` replace
 * the item-level `required_for_completion` flags in one write so the UI has
 * a single place to say "these must be done".
 */
export class UpdateCompletionRuleDto {
  /** `'all'`, `'none'` or a minimum lesson count. */
  @IsOptional()
  @ValidateIf((o) => typeof o.lessons === 'string')
  @IsIn(['all', 'none'])
  readonly lessons?: 'all' | 'none' | number;

  @IsOptional()
  @IsBoolean()
  readonly requiredQuizzes?: boolean;

  @IsOptional()
  @IsBoolean()
  readonly requiredAssignments?: boolean;

  @IsOptional()
  @ValidateIf((o) => o.minOverallScore !== null)
  @IsInt()
  @Min(0)
  @Max(100)
  readonly minOverallScore?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  readonly requiredQuizIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  readonly requiredAssignmentIds?: string[];

  @IsOptional()
  @IsBoolean()
  readonly certificatesEnabled?: boolean;

  @IsOptional()
  @ValidateIf((o) => o.certificateMinScore !== null)
  @IsInt()
  @Min(0)
  @Max(100)
  readonly certificateMinScore?: number | null;

  @IsOptional()
  @ValidateIf((o) => o.certificateTemplateId !== null)
  @IsString()
  readonly certificateTemplateId?: string | null;
}
