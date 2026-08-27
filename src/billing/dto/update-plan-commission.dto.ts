/** `PATCH /platform-commission/plans/:planKey` request (Platform-Owner-only, §4.2's Phase-P13 plan-tier extension). Basis points only — never a float, matching every other commission DTO in this codebase. */
import { IsInt, Max, Min } from 'class-validator';

export class UpdatePlanCommissionDto {
  @IsInt()
  @Min(0)
  @Max(10000)
  readonly commissionBasisPoints!: number;
}
