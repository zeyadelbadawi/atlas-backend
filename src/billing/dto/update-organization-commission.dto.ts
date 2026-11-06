/**
 * `PATCH /platform-commission/organizations/:organizationId` request
 * (Platform-Owner-only, master plan §4.2). `customPercentageBasisPoints`
 * is required exactly when `commissionMode='custom'` — enforced here via
 * `ValidateIf` AND re-checked in `CommissionService` (defense in depth,
 * matching this codebase's "never trust one layer alone" discipline).
 */
import { IsIn, ValidateIf } from 'class-validator';
import {
  COMMISSION_RANGE_MESSAGE_KEY,
  COMMISSION_RANGE_PERCENT,
} from './billing.constants';
import { IsIntInRange } from '../../common/validation/violation-message';
import type { OrganizationCommissionSettings } from '@prisma/client';

const MODES: readonly OrganizationCommissionSettings['commissionMode'][] = [
  'default',
  'custom',
  'exempt',
];

export class UpdateOrganizationCommissionDto {
  @IsIn(MODES)
  readonly commissionMode!: OrganizationCommissionSettings['commissionMode'];

  @ValidateIf((dto: UpdateOrganizationCommissionDto) => dto.commissionMode === 'custom')
  @IsIntInRange(0, 10000, COMMISSION_RANGE_MESSAGE_KEY, COMMISSION_RANGE_PERCENT)
  readonly customPercentageBasisPoints?: number;
}
