/** `POST courses/:id/forum/threads` request — matches `CreateForumThreadPayload` exactly. `@IsNotEmpty()` for required fields — see `RegisterDto`'s comment (identity module): the other decorators silently skip `undefined`. */
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * B6 (UX audit) V04 — trimmed before validation, so a post of only spaces
 * is refused as empty instead of being saved as a blank card.
 */
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateForumThreadDto {
  @Transform(trim)
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  readonly title!: string;

  @Transform(trim)
  @IsNotEmpty()
  @IsString()
  @MaxLength(10000)
  readonly body!: string;
}
