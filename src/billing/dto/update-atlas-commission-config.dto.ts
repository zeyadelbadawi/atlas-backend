/**
 * `PATCH /platform-commission/global` request (Platform-Owner-only, master
 * plan §4.2). There is deliberately no way to send `null`/unset through
 * this DTO — setting the global default is a one-way transition into
 * configured (matches `AtlasCommissionConfigRepository.setDefault`'s own
 * doc comment); this document does not invent an "unset" product flow.
 */
import {
  COMMISSION_RANGE_MESSAGE_KEY,
  COMMISSION_RANGE_PERCENT,
} from './billing.constants';
import { IsIntInRange } from '../../common/validation/violation-message';

export class UpdateAtlasCommissionConfigDto {
  @IsIntInRange(0, 10000, COMMISSION_RANGE_MESSAGE_KEY, COMMISSION_RANGE_PERCENT)
  readonly defaultCommissionBasisPoints!: number;
}
