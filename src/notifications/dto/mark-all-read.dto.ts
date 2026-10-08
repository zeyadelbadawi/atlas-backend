/**
 * `POST notifications/read-all` body (optional).
 *
 * `before` bounds the action to notifications that existed when the person
 * pressed "Mark all as read". A client that queued the action while offline
 * (local-first dashboard) replays it later; without the bound, every
 * notification that arrived in between would be marked read unseen.
 */
import { IsISO8601, IsOptional } from 'class-validator';

export class MarkAllReadDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  readonly before?: string;
}
