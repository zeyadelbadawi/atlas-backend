/**
 * Body of `POST /academies/:id/delete`.
 *
 * WHY THE REASON VOCABULARY IS CLOSED. "Why did you delete this?" is only
 * useful if the answers aggregate, and free text does not aggregate. The
 * same reasoning — and deliberately a parallel shape — as subscription
 * cancellation and account deletion, so the three "why did you leave"
 * signals can be read together.
 *
 * WHY `confirm` IS REQUIRED AND MUST BE `true`. Deleting an Academy takes
 * its public website offline. An accidental or replayed request with an
 * empty body must not be able to do that, so intent is carried in the
 * payload rather than inferred from the route being called.
 */
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const ACADEMY_ARCHIVE_REASONS = [
  'created_by_mistake',
  'no_longer_needed',
  'replacing_with_another',
  'testing_only',
  'too_expensive',
  'switching_provider',
  'other',
] as const;

export type AcademyArchiveReason = (typeof ACADEMY_ARCHIVE_REASONS)[number];

export class DeleteAcademyDto {
  /**
   * `@IsIn([true])` rather than a bare `@IsBoolean()`: `confirm: false`
   * must be refused, not quietly treated as consent.
   */
  @IsBoolean()
  @IsIn([true])
  confirm!: true;

  @IsOptional()
  @IsIn(ACADEMY_ARCHIVE_REASONS)
  reason?: AcademyArchiveReason;

  /** Optional free text. Never required, and never gates the deletion. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  feedback?: string;
}
