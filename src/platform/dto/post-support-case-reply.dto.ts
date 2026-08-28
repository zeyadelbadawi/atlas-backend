/** `POST /support-cases/:id/messages` request — matches `PostSupportCaseReplyPayload` (atlas frontend `support.types.ts`) exactly. */
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { MAX_SUPPORT_REPLY_BODY_LENGTH } from './support.constants';

export class PostSupportCaseReplyDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(MAX_SUPPORT_REPLY_BODY_LENGTH)
  readonly body!: string;
}
