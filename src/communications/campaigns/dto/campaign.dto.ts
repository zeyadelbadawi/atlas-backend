/**
 * W3-compose — request DTOs for both composers.
 *
 * `audience` is a discriminated union, which class-validator cannot
 * express on its own; it arrives as an object and is parsed STRICTLY by
 * `parseAudience` (unknown types, unknown keys, malformed ids and
 * out-of-range lists are all a 400), so nothing but a well-formed typed
 * predicate ever reaches the SQL builder.
 */
import { BadRequestException } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type { AcademyMemberRole, TenantSubscriptionStatus } from '@prisma/client';
import {
  CAMPAIGN_BODY_HTML_MAX,
  CAMPAIGN_SUBJECT_MAX,
  MAX_COURSE_FILTER,
  MAX_PLAN_FILTER,
  type AcademyAudience,
  type CampaignScope,
  type PlatformAudience,
} from '../campaign.types';

export class CampaignChannelsDto {
  @IsBoolean()
  readonly email!: boolean;

  @IsBoolean()
  readonly inApp!: boolean;
}

export class PreviewCampaignDto {
  @IsObject()
  readonly audience!: Record<string, unknown>;

  @ValidateNested()
  @Type(() => CampaignChannelsDto)
  readonly channels!: CampaignChannelsDto;
}

export class SendCampaignDto extends PreviewCampaignDto {
  /** Client-generated; reused verbatim when the client retries. */
  @IsUUID()
  readonly idempotencyKey!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(CAMPAIGN_SUBJECT_MAX)
  readonly subject!: string;

  @IsString()
  @MaxLength(CAMPAIGN_BODY_HTML_MAX)
  readonly bodyHtml!: string;

  @IsOptional()
  @IsIn(['en', 'ar'])
  readonly contentLocale?: 'en' | 'ar';

  /** The `recipientCount` the person saw in the preview they confirmed. */
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  readonly expectedRecipientCount!: number;

  @IsOptional()
  @IsBoolean()
  readonly confirmLargeAudience?: boolean;
}

export class ListCampaignsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  readonly limit?: number;

  @IsOptional()
  @IsUUID()
  readonly cursor?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_KEY = /^[A-Za-z0-9_.-]{1,100}$/;
const STAFF_ROLES: readonly AcademyMemberRole[] = [
  'owner',
  'administrator',
  'manager',
  'instructor',
  'staff',
];
const SUBSCRIPTION_STATUSES: readonly TenantSubscriptionStatus[] = [
  'no_plan',
  'trialing',
  'trial_expired',
  'active',
  'past_due',
  'paused',
  'grace_period',
  'cancelled',
  'expired',
];
const ACADEMY_STATUSES = ['draft', 'active', 'suspended'] as const;

function invalid(reason: string): never {
  throw new BadRequestException({
    messageKey: 'errors.messaging.audienceInvalid',
    code: 'CAMPAIGN_AUDIENCE_INVALID',
    details: { reason },
  });
}

function onlyKeys(raw: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) invalid(`unexpected key ${key}`);
  }
}

function list<T extends string>(
  value: unknown,
  field: string,
  options: { min: number; max: number; allowed?: readonly T[]; pattern?: RegExp },
): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) invalid(`${field} must be a list`);
  const items = value as unknown[];
  if (items.length < options.min || items.length > options.max) {
    invalid(`${field} must have ${options.min}-${options.max} entries`);
  }
  const out = new Set<T>();
  for (const item of items) {
    if (typeof item !== 'string') invalid(`${field} entries must be strings`);
    const text = item as string;
    if (options.allowed && !options.allowed.includes(text as T))
      invalid(`${field}: ${text}`);
    if (options.pattern && !options.pattern.test(text))
      invalid(`${field}: malformed entry`);
    out.add(text as T);
  }
  return [...out];
}

export function parseAcademyAudience(raw: Record<string, unknown>): AcademyAudience {
  switch (raw.type) {
    case 'learners':
      onlyKeys(raw, ['type']);
      return { type: 'learners' };
    case 'courses': {
      onlyKeys(raw, ['type', 'courseIds']);
      const courseIds = list<string>(raw.courseIds, 'courseIds', {
        min: 1,
        max: MAX_COURSE_FILTER,
        pattern: UUID,
      });
      if (!courseIds) invalid('courseIds is required');
      return { type: 'courses', courseIds };
    }
    case 'staff': {
      onlyKeys(raw, ['type', 'roles']);
      const roles = list<AcademyMemberRole>(raw.roles, 'roles', {
        min: 1,
        max: STAFF_ROLES.length,
        allowed: STAFF_ROLES,
      });
      if (!roles) invalid('roles is required');
      return { type: 'staff', roles };
    }
    default:
      return invalid('unknown audience type');
  }
}

export function parsePlatformAudience(raw: Record<string, unknown>): PlatformAudience {
  switch (raw.type) {
    case 'org_owners':
      onlyKeys(raw, ['type']);
      return { type: 'org_owners' };
    case 'academy_owners_admins':
      onlyKeys(raw, ['type']);
      return { type: 'academy_owners_admins' };
    case 'academy_owners': {
      onlyKeys(raw, ['type', 'planKeys', 'subscriptionStatuses', 'academyStatuses']);
      const planKeys = list<string>(raw.planKeys, 'planKeys', {
        min: 1,
        max: MAX_PLAN_FILTER,
        pattern: PLAN_KEY,
      });
      const subscriptionStatuses = list<TenantSubscriptionStatus>(
        raw.subscriptionStatuses,
        'subscriptionStatuses',
        { min: 1, max: SUBSCRIPTION_STATUSES.length, allowed: SUBSCRIPTION_STATUSES },
      );
      const academyStatuses = list<(typeof ACADEMY_STATUSES)[number]>(
        raw.academyStatuses,
        'academyStatuses',
        { min: 1, max: ACADEMY_STATUSES.length, allowed: ACADEMY_STATUSES },
      );
      return {
        type: 'academy_owners',
        ...(planKeys ? { planKeys } : {}),
        ...(subscriptionStatuses ? { subscriptionStatuses } : {}),
        ...(academyStatuses ? { academyStatuses } : {}),
      };
    }
    case 'organization': {
      onlyKeys(raw, ['type', 'organizationId']);
      if (typeof raw.organizationId !== 'string' || !UUID.test(raw.organizationId)) {
        invalid('organizationId must be a uuid');
      }
      return { type: 'organization', organizationId: raw.organizationId as string };
    }
    default:
      return invalid('unknown audience type');
  }
}

export function parseAudience(
  scope: CampaignScope,
  raw: Record<string, unknown>,
): AcademyAudience | PlatformAudience {
  return scope === 'academy' ? parseAcademyAudience(raw) : parsePlatformAudience(raw);
}
