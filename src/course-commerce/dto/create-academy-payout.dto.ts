/** `POST /platform-academy-payouts` request (Platform-Owner-only). Computes and records a payout for one Academy over one period — see `PlatformAcademyPayoutsService.createPayout`'s own doc comment for why this is a Platform-triggered recording action, not an automated job, in this phase. */
import { IsISO8601, IsNotEmpty, IsString } from 'class-validator';

export class CreateAcademyPayoutDto {
  @IsNotEmpty()
  @IsString()
  readonly academyId!: string;

  @IsISO8601()
  readonly periodStart!: string;

  @IsISO8601()
  readonly periodEnd!: string;
}
