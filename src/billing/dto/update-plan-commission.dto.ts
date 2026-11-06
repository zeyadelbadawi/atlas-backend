/** `PATCH /platform-commission/plans/:planKey` request (Platform-Owner-only, §4.2's Phase-P13 plan-tier extension). Basis points only — never a float, matching every other commission DTO in this codebase. */
import {
  COMMISSION_RANGE_MESSAGE_KEY,
  COMMISSION_RANGE_PERCENT,
} from './billing.constants';
import { IsIntInRange } from '../../common/validation/violation-message';

export class UpdatePlanCommissionDto {
  @IsIntInRange(0, 10000, COMMISSION_RANGE_MESSAGE_KEY, COMMISSION_RANGE_PERCENT)
  readonly commissionBasisPoints!: number;
}
