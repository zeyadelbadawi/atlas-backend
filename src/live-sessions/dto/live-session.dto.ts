/**
 * Live Session request bodies.
 *
 * VALIDATION LIVES HERE BECAUSE THIS IS THE AUTHORITATIVE LAYER. The
 * browser validates the same things for UX, but every rule that actually
 * protects data is enforced server-side — a caller with `curl` gets the
 * identical refusal.
 *
 * The cross-field rules (end after start, sane duration) are checked in
 * `LiveSessionService`, not here: class-validator decorators see one
 * property at a time, and a rule expressed half in a DTO and half in a
 * service is a rule nobody can find later.
 */
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const LIVE_SESSION_TITLE_MAX = 200;
export const LIVE_SESSION_DESCRIPTION_MAX = 2000;

export class CreateLiveSessionDto {
  @IsString()
  @MinLength(1, { message: 'validation:required' })
  @MaxLength(LIVE_SESSION_TITLE_MAX, { message: 'validation:maxLength' })
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(LIVE_SESSION_DESCRIPTION_MAX, { message: 'validation:maxLength' })
  description?: string;

  /**
   * Unit placement. Optional — matching how `quizzes`/`assignments` attach
   * — but when supplied it is verified to belong to THIS course, so a
   * section id from another course (or another tenant) is refused rather
   * than silently creating an orphan.
   */
  @IsOptional()
  @IsUUID(undefined, { message: 'validation:invalid' })
  sectionId?: string;

  @IsDateString(undefined, { message: 'validation:invalid' })
  scheduledStartAt!: string;

  @IsDateString(undefined, { message: 'validation:invalid' })
  scheduledEndAt!: string;

  /** Defaults to the caller when omitted; always verified to be a real instructor on this academy. */
  @IsOptional()
  @IsUUID(undefined, { message: 'validation:invalid' })
  hostUserId?: string;

  /**
   * RECORDING IS OFF UNLESS EXPLICITLY REQUESTED. Absent means false —
   * never "inherit whatever the Zoom account does by default".
   */
  @IsOptional()
  @IsBoolean()
  recordingEnabled?: boolean;
}

export class UpdateLiveSessionDto {
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'validation:required' })
  @MaxLength(LIVE_SESSION_TITLE_MAX, { message: 'validation:maxLength' })
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(LIVE_SESSION_DESCRIPTION_MAX, { message: 'validation:maxLength' })
  description?: string;

  @IsOptional()
  @IsUUID(undefined, { message: 'validation:invalid' })
  sectionId?: string;

  @IsOptional()
  @IsDateString(undefined, { message: 'validation:invalid' })
  scheduledStartAt?: string;

  @IsOptional()
  @IsDateString(undefined, { message: 'validation:invalid' })
  scheduledEndAt?: string;

  @IsOptional()
  @IsUUID(undefined, { message: 'validation:invalid' })
  hostUserId?: string;

  @IsOptional()
  @IsBoolean()
  recordingEnabled?: boolean;

  /**
   * Publishing state, restricted to the transitions a human actually
   * performs. `live`/`ended`/`failed` are NOT settable here — those are
   * consequences of real events, and letting a client assert them would
   * make the lifecycle a suggestion rather than a record.
   */
  @IsOptional()
  @IsIn(['draft', 'scheduled', 'cancelled'], { message: 'validation:invalidValue' })
  status?: 'draft' | 'scheduled' | 'cancelled';
}

/** Reordering within a unit — the curriculum drag-and-drop. */
export class ReorderLiveSessionDto {
  @IsOptional()
  @IsUUID(undefined, { message: 'validation:invalid' })
  sectionId?: string;

  /** Non-negative position within the unit. Bounded so a client cannot send an absurd integer. */
  @IsInt({ message: 'validation:invalid' })
  @Min(0, { message: 'validation:invalidValue' })
  @Max(10_000, { message: 'validation:invalidValue' })
  order!: number;
}
