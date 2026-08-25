/** `POST courses/:id/forum/threads/:threadId/replies` request — matches `CreateForumReplyPayload` exactly. */
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateForumReplyDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(10000)
  readonly body!: string;
}
