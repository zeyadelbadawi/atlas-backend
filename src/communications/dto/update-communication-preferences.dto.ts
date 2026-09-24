/**
 * `PATCH /users/me/communication-preferences` body — a partial of the
 * three things a person may change. `security`, `transactional` and the
 * locked half of `lifecycle` are deliberately NOT here: sending them is a
 * 400 (`forbidNonWhitelisted`), never a silent no-op.
 */
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, ValidateNested } from 'class-validator';

export class LifecyclePreferenceDto {
  @IsOptional()
  @IsBoolean()
  readonly reminders?: boolean;
}

export class EngagementPreferenceDto {
  @IsOptional()
  @IsBoolean()
  readonly email?: boolean;

  @IsOptional()
  @IsIn(['immediate', 'daily', 'off'])
  readonly digest?: 'immediate' | 'daily' | 'off';
}

export class OperationalPreferenceDto {
  @IsOptional()
  @IsBoolean()
  readonly email?: boolean;

  @IsOptional()
  @IsIn(['immediate', 'daily'])
  readonly digest?: 'immediate' | 'daily';
}

export class UpdateCommunicationPreferencesDto {
  @IsOptional()
  @IsIn(['en', 'ar'])
  readonly language?: 'en' | 'ar';

  @IsOptional()
  @ValidateNested()
  @Type(() => LifecyclePreferenceDto)
  readonly lifecycle?: LifecyclePreferenceDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => EngagementPreferenceDto)
  readonly engagement?: EngagementPreferenceDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => OperationalPreferenceDto)
  readonly operational?: OperationalPreferenceDto;
}
