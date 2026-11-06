/** `POST courses/:id/forum/threads/:threadId/replies` request — matches `CreateForumReplyPayload` exactly. */
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * B6 (UX audit) V04 — trimmed before validation, so a post of only spaces
 * is refused as empty instead of being saved as a blank card.
 */
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateForumReplyDto {
  @Transform(trim)
  @IsNotEmpty()
  @IsString()
  @MaxLength(10000)
  readonly body!: string;
}
