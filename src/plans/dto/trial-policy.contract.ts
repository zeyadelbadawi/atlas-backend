/**
 * `TrialPolicy` contracts — matches `TrialPolicy` (`plan.types.ts`)
 * field-for-field.
 *
 * B8 (UX audit) V23 — `durationDays` is a whole number from 1 to 365, the
 * same range a plan's own `trialDurationDays` already had. `0` used to be
 * accepted "regardless of `enabled`", and a stored 0 gave every new
 * organization a trial that ended the moment it began (see
 * `plans-catalog.e2e-spec.ts`'s note on the shared singleton); switching
 * trials off is what `enabled: false` is for. There was no ceiling at all.
 */
import { IsBoolean, IsNotEmpty } from 'class-validator';
import type { TrialPolicy as PrismaTrialPolicy } from '@prisma/client';
import { IsIntInRange } from '../../common/validation/violation-message';

/** The trial length range, in days — the trial policy and a plan's own override. */
export const TRIAL_DAYS_MIN = 1;
export const TRIAL_DAYS_MAX = 365;

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
  @IsIntInRange(TRIAL_DAYS_MIN, TRIAL_DAYS_MAX)
  readonly durationDays!: number;
}
