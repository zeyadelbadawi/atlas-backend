/**
 * `POST /academies` request — matches `CreateAcademyPayload` (atlas
 * frontend `src/types/academy.types.ts`) field-for-field, plus
 * `organizationId`.
 *
 * `organizationId` is NOT part of `CreateAcademyPayload` today — tracing
 * the actual frontend code (`AcademyService.createAcademy`,
 * `useAcademies.ts`, `http-client.ts`) end-to-end found no channel (header,
 * param, or body field) that currently carries the active organization to
 * any `/academies` request. This is a genuine, confirmed gap, not a design
 * choice made in this codebase already — resolved by product decision
 * (2026-08-23) as: require it as an explicit request field, the same
 * "always explicit, never ambient" convention P2 already established for
 * `/organizations/:id/*`. The frontend does not send this field yet; that
 * is a separate, tracked frontend gap (see `Reports/PROGRESS.md`), out of
 * this backend-only phase's scope to fix.
 *
 * Validation floors mirror the frontend's own `createAcademySchema`
 * (`atlas frontend/src/features/academy/schemas/academy.schemas.ts`)
 * exactly — same slug regex, same max lengths — so a request the frontend
 * form would accept never round-trips into a 400 the backend invented.
 */
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
} from 'class-validator';

// Matches `atlas frontend/src/features/academy/schemas/academy.schemas.ts`'s `SLUG_REGEX`.
export const ACADEMY_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_ACADEMY_NAME_LENGTH = 100;
export const MAX_ACADEMY_DESCRIPTION_LENGTH = 500;
export const MAX_ACADEMY_SLUG_LENGTH = 50;

// See `RegisterDto`'s comment (identity module): `@IsNotEmpty()` is what
// actually rejects a missing required field; class-validator's other
// decorators silently skip `undefined`.
export class CreateAcademyDto {
  @IsNotEmpty()
  @IsString()
  readonly organizationId!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(MAX_ACADEMY_NAME_LENGTH)
  readonly name!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(MAX_ACADEMY_SLUG_LENGTH)
  @Matches(ACADEMY_SLUG_REGEX, { message: 'errors.academy.invalidSlug' })
  readonly slug!: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ACADEMY_DESCRIPTION_LENGTH)
  readonly description?: string;

  @IsOptional()
  @IsEmail()
  readonly contactEmail?: string;

  @IsOptional()
  @IsString()
  readonly contactPhone?: string;

  @IsOptional()
  @IsUrl()
  readonly website?: string;

  @IsOptional()
  @IsString()
  readonly country?: string;

  @IsOptional()
  @IsString()
  readonly language?: string;

  @IsOptional()
  @IsString()
  readonly timezone?: string;

  @IsOptional()
  @IsString()
  readonly currency?: string;
}
