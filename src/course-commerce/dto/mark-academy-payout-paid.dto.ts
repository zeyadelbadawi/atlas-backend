/** `POST /platform-academy-payouts/:id/mark-paid` request (Platform-Owner-only). `providerReference` stays optional/undefined under the Model-A manual bridge (no real Connect-style processor integrated yet, master plan §5.8) — populated by a future real payout integration, not fabricated here. */
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class MarkAcademyPayoutPaidDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  readonly providerReference?: string;
}
