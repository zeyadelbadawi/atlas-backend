/**
 * The staff authoring payload for a lesson's protected content body.
 *
 * WHY THIS EXISTS. `lesson_contents` was created, given RLS policies and a
 * one-time backfill by P64 Phase 2's first migration, and
 * `LessonContentService` reads it to decide every protected grant — but
 * nothing in the application could ever WRITE a row. Every lesson created
 * after that migration therefore had no content row, and the grant path
 * refused it (`lesson-content.service.ts`'s `if (!lesson.content)`), which
 * is correct behaviour against data that cannot exist. A production smoke
 * test confirmed it end to end: the video uploaded, completed with a
 * parsed duration and attached to the lesson, `can_access_lesson` returned
 * true for the enrolled learner, and the grant still answered 404.
 *
 * Attaching `course_lessons.video_asset_id` is NOT the same thing. That
 * column says which asset a lesson plays; `lesson_contents` is the row the
 * grant path resolves. Both are required, and only the first had a writer.
 *
 * `kind: text` IS DELIBERATELY REFUSED HERE. The column's own schema
 * comment is "Sanitised rich text for `kind: text`. Server-sanitised on
 * write", and this repository has no HTML sanitiser and no sanitisation
 * dependency. Accepting rich text without one would mean either storing
 * unsanitised HTML behind a field that promises otherwise, or shipping a
 * hand-rolled sanitiser — and a hand-rolled HTML sanitiser is a security
 * control invented under deadline, which is the worse of the two. Text
 * lessons backfilled by the migration keep working; authoring new ones
 * waits for a reviewed sanitiser.
 */
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

/** Every kind the column models. `text` parses here and is refused in the service, so the refusal carries a reason rather than a validation error that cannot explain itself. */
export const LESSON_CONTENT_KINDS = ['text', 'video', 'file', 'external'] as const;
export type LessonContentKindInput = (typeof LESSON_CONTENT_KINDS)[number];

/** Matches the `external_url` column and leaves room for a long signed third-party address. */
const MAX_EXTERNAL_URL_LENGTH = 2048;

export class UpsertLessonContentDto {
  @IsNotEmpty()
  @IsIn(LESSON_CONTENT_KINDS)
  readonly kind!: LessonContentKindInput;

  /**
   * The protected object for `kind: video` and `kind: file`.
   *
   * Validated as a string here and as a TENANCY fact in the service: an
   * id alone proves nothing, so the asset is re-read scoped to this
   * academy before it is ever linked.
   */
  @IsOptional()
  @IsString()
  readonly mediaAssetId?: string;

  /**
   * `kind: external` only — a third-party embed Atlas does not host and
   * tells the learner is not protected.
   *
   * HTTPS is required rather than preferred: the learner surface is
   * served over TLS, so an `http:` embed is a mixed-content block in
   * every current browser — it would fail silently at playback rather
   * than loudly here.
   */
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(MAX_EXTERNAL_URL_LENGTH)
  readonly externalUrl?: string;
}
