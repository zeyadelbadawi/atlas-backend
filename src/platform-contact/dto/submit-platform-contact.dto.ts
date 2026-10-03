/**
 * `POST public/contact` request — the Atlas marketing homepage's contact
 * form.
 *
 * Every text field is TRIMMED before it is validated, so a value made only
 * of whitespace fails `MinLength`/`IsNotEmpty` instead of slipping through
 * the way it does on the academy form. The global `ValidationPipe`
 * (`whitelist` + `forbidNonWhitelisted` + `transform`, see `main.ts`)
 * rejects any property not declared here, so a caller cannot smuggle
 * `status`, `ipHash` or `readAt` into the row.
 *
 * Two anti-automation fields travel with the form and never reach the
 * database:
 *   - `company` — the HONEYPOT. Rendered hidden from people; only a filler
 *     sends a value. (The real organization field is `organizationName`.)
 *   - `startedAt` — when the form was first rendered, in epoch ms. A
 *     submission that arrives faster than a person could type is dropped.
 * Both are answered with the ordinary success response, so neither check
 * can be probed from outside.
 */
import { Transform, type TransformFnParams } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { PlatformContactTopic } from '@prisma/client';
import {
  PLATFORM_CONTACT_LIMITS as LIMITS,
  PLATFORM_CONTACT_LOCALES,
  PLATFORM_CONTACT_TOPICS,
} from '../platform-contact.constants';

/** Trims strings; leaves anything else alone so `IsString` can reject it. */
function trim({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** Trims, and turns an empty optional value into "absent". */
function trimOptional({ value }: TransformFnParams): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeEmailValue({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

export class SubmitPlatformContactDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MinLength(LIMITS.nameMin)
  @MaxLength(LIMITS.nameMax)
  readonly name!: string;

  @Transform(normalizeEmailValue)
  @IsString()
  @IsNotEmpty()
  @MaxLength(LIMITS.emailMax)
  @IsEmail()
  readonly email!: string;

  @IsOptional()
  @Transform(trimOptional)
  @IsString()
  @MaxLength(LIMITS.organizationMax)
  readonly organizationName?: string;

  @IsIn(PLATFORM_CONTACT_TOPICS)
  readonly topic!: PlatformContactTopic;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MinLength(LIMITS.messageMin)
  @MaxLength(LIMITS.messageMax)
  readonly message!: string;

  @IsOptional()
  @IsIn(PLATFORM_CONTACT_LOCALES)
  readonly locale?: (typeof PLATFORM_CONTACT_LOCALES)[number];

  /** A site path (`/`, `/pricing`) — never a full URL, never a query string. */
  @IsOptional()
  @Transform(trimOptional)
  @IsString()
  @MaxLength(LIMITS.sourcePathMax)
  @Matches(/^\/[A-Za-z0-9\-._~/]*$/)
  readonly sourcePath?: string;

  /** Honeypot — see the file header. */
  @IsOptional()
  @IsString()
  @MaxLength(LIMITS.honeypotMax)
  readonly company?: string;

  /** Epoch ms when the form was rendered — see the file header. */
  @IsInt()
  @Min(0)
  readonly startedAt!: number;
}
