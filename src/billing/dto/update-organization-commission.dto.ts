/**
 * `PATCH /platform-commission/organizations/:organizationId` request
 * (Platform-Owner-only, master plan §4.2). `customPercentageBasisPoints`
 * is required exactly when `commissionMode='custom'` — enforced here via
 * `ValidateIf` AND re-checked in `CommissionService` (defense in depth,
 * matching this codebase's "never trust one layer alone" discipline).
 */
import { IsIn, IsInt, Max, Min, ValidateIf } from 'class-validator';
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
  @IsInt()
  @Min(0)
  @Max(10000)
  readonly customPercentageBasisPoints?: number;
}
