/**
 * `TrialPolicy` contracts — matches `TrialPolicy` (`plan.types.ts`)
 * field-for-field. `UpdateTrialPolicyDto` mirrors the frontend's own
 * `updateTrialPolicySchema` (`tenant.schemas.ts`) exactly: `durationDays`
 * only needs to be a non-negative integer, `0` is legitimate regardless
 * of `enabled` — no business constraint invented beyond what the frontend
 * form itself enforces.
 */
import { IsBoolean, IsInt, IsNotEmpty, Min } from 'class-validator';
import type { TrialPolicy as PrismaTrialPolicy } from '@prisma/client';

export interface TrialPolicyResponse {
  readonly enabled: boolean;
  readonly durationDays: number;
}

export function toTrialPolicyResponse(policy: PrismaTrialPolicy): TrialPolicyResponse {
  return {
    enabled: policy.enabled,
    durationDays: policy.durationDays,
  };
}

// See `RegisterDto`'s comment (identity module): `@IsNotEmpty()` is what
// actually rejects a missing required field; class-validator's other
// decorators silently skip `undefined`. Safe on `enabled` here because
// `IsNotEmpty`'s "empty" check never fires on `false`.
export class UpdateTrialPolicyDto {
  @IsNotEmpty()
  @IsBoolean()
  readonly enabled!: boolean;

  @IsNotEmpty()
  @IsInt()
  @Min(0)
  readonly durationDays!: number;
}
