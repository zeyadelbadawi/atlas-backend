/**
 * Playback request bodies (master plan Phase 2 §L).
 *
 * `positionSeconds` is the ONLY number the client is allowed to report,
 * and it is used for RESUME, never as evidence of watching — see
 * `playback-evidence.util.ts` for why a client-reported watched-delta
 * would make the completion rule decorative. Bounded here as well as
 * clamped there, so an absurd value is rejected at the edge rather than
 * silently normalised.
 */
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** 24 hours. No lesson is longer, and a larger number is a client bug or an attempt. */
const MAX_POSITION_SECONDS = 24 * 60 * 60;

export class PlaybackHeartbeatDto {
  @IsString()
  lessonId!: string;

  @IsInt()
  @Min(0)
  @Max(MAX_POSITION_SECONDS)
  positionSeconds!: number;

  /** Absent when the grant was issued without a lease (lease store unavailable). */
  @IsOptional()
  @IsString()
  leaseId?: string;
}

export class ReleaseLeaseDto {
  @IsString()
  leaseId!: string;
}

export class SessionTakeoverDto {
  @IsOptional()
  @IsString()
  courseId?: string;

  @IsOptional()
  @IsString()
  lessonId?: string;
}
