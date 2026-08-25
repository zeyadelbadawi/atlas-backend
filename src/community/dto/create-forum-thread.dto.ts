/** `POST courses/:id/forum/threads` request — matches `CreateForumThreadPayload` exactly. `@IsNotEmpty()` for required fields — see `RegisterDto`'s comment (identity module): the other decorators silently skip `undefined`. */
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateForumThreadDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  readonly title!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(10000)
  readonly body!: string;
}
