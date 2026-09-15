/** `POST /support-cases/:id/messages` request — matches `PostSupportCaseReplyPayload` (atlas frontend `support.types.ts`) exactly. */
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MAX_SUPPORT_REPLY_BODY_LENGTH } from './support.constants';
import { SupportAttachmentInputDto } from './support-attachment.dto';

export class PostSupportCaseReplyDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(MAX_SUPPORT_REPLY_BODY_LENGTH)
  readonly body!: string;

  /** P53 — an optional image on this reply. See `CreateSupportCaseDto.attachment`. */
  @IsOptional()
  @ValidateNested()
  @Type(() => SupportAttachmentInputDto)
  readonly attachment?: SupportAttachmentInputDto;
}
