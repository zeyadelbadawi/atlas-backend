import { IsIn, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';

/** `POST /platform-privacy-requests/:id/status` — start handling, or decline with a reason. */
export class UpdatePrivacyRequestStatusDto {
  @IsIn(['in_progress', 'rejected'], { message: 'validation:invalidValue' })
  status!: 'in_progress' | 'rejected';

  /** Required when declining (it is what the person is told); ignored otherwise. */
  @ValidateIf((dto: UpdatePrivacyRequestStatusDto) => dto.status === 'rejected')
  @IsString()
  @MinLength(5, { message: 'validation:minLength' })
  @MaxLength(2000, { message: 'validation:maxLength' })
  note?: string;
}
