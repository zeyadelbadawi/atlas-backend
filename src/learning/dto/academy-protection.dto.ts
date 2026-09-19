/**
 * Owner-only academy settings for P64 Phase 2 (master plan D8, §D.9,
 * §K, §L).
 *
 * D8 puts both of these in the Client Owner's hands and nobody else's:
 * they decide how hard it is to copy this academy's content, and how many
 * devices its learners may use. An administrator or manager can run the
 * academy day to day without being able to quietly weaken its protection.
 */
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class ContentProtectionDto {
  @IsBoolean()
  watermark!: boolean;

  /** Null (or omitted) uses the viewer's own short id — see `content-protection.contract.ts`. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  watermarkText?: string;

  @IsBoolean()
  disableDownload!: boolean;

  @IsBoolean()
  disablePip!: boolean;

  @IsBoolean()
  disableContextMenu!: boolean;
}

export class UpdateContentProtectionDto {
  @ValidateNested()
  @Type(() => ContentProtectionDto)
  contentProtection!: ContentProtectionDto;
}

/**
 * The academy's device policy.
 *
 * Bounded here as well as clamped in `AccessPolicyService`: the DTO stops
 * an obviously wrong number from ever being stored, while the resolver
 * enforces the live platform maximum, which can change after a value was
 * written. Both are needed — a stored 50 that the platform later caps at
 * 2 must resolve to 2, and a stored 0 must never be accepted at all
 * because it would lock every learner out of the academy.
 */
export class UpdateDevicePolicyDto {
  @IsInt()
  @Min(1)
  @Max(20)
  maxDevices!: number;

  @IsInt()
  @Min(1)
  @Max(10)
  maxConcurrentSessions!: number;
}

/**
 * The academy's DEFAULT video security tier (D10, D11).
 *
 * A default for NEW uploads, never a statement about existing assets:
 * `media_assets.security_tier` records what each asset actually is, and a
 * tier change never rewrites history (D11). Bounded by what the
 * organization's plan family entitles — an academy cannot select a tier
 * nobody is paying for — and refused rather than silently lowered, for
 * the same reason the device policy is.
 */
export class UpdateVideoTierDto {
  @IsIn(['normal', 'premium'])
  videoSecurityTier!: 'normal' | 'premium';
}
