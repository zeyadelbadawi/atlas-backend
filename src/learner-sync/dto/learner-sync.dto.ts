import {
  IsBoolean,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export const NOTE_MAX_LENGTH = 4000;

/** `PUT learning/notes/:lessonId` — the phone's copy of one lesson's note. */
export class PutLearnerNoteDto {
  @IsString()
  @MaxLength(64)
  readonly courseId!: string;

  @IsString()
  @MaxLength(NOTE_MAX_LENGTH)
  readonly note!: string;

  @IsBoolean()
  readonly saved!: boolean;

  /** When the learner made this edit, on the phone (last write wins). */
  @IsISO8601({ strict: true })
  readonly editedAt!: string;
}

/** `GET learning/streak?tz=` — the learner's IANA time zone. */
export class StreakQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9_+\-/]+$/)
  readonly tz?: string;

  /** Only where the host resolves to no academy (see the controller). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  readonly academyId?: string;
}

export interface LearnerNoteResponse {
  readonly courseId: string;
  readonly lessonId: string;
  readonly courseTitle: string;
  readonly lessonTitle: string;
  readonly note: string;
  readonly saved: boolean;
  readonly editedAt: string;
}

export interface PutLearnerNoteResponse extends LearnerNoteResponse {
  /** False when the server already held a newer edit (returned instead). */
  readonly applied: boolean;
}

export interface StudyDaysResponse {
  readonly timeZone: string;
  /** Local dates (`YYYY-MM-DD`) with study activity, newest first. */
  readonly days: readonly string[];
}
