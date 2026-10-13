/**
 * B0-ANL-04 — operator-only organization flags (Platform Owner).
 *
 * `isInternal` marks a test, demo or staff organization so platform
 * metrics (MRR, B0-ANL-01) leave it out. Tenants never see or set it.
 */
import { IsBoolean } from 'class-validator';

export class UpdateOrganizationPlatformFlagsDto {
  @IsBoolean()
  readonly isInternal!: boolean;
}

export interface OrganizationPlatformFlagsResponse {
  readonly organizationId: string;
  readonly isInternal: boolean;
  /** Absent until the flag has been set once. */
  readonly updatedAt?: string;
}
