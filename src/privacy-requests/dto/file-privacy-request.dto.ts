/**
 * `POST /privacy-requests` — files a request for the CALLER. Carries no user
 * id: the subject is always the account proved by the access token.
 */
import { IsIn, IsString, IsUUID, Matches } from 'class-validator';
import type { PrivacyRequestType } from '@prisma/client';
import { PRIVACY_REQUEST_TYPES } from '../privacy-requests.constants';

export class FilePrivacyRequestDto {
  @IsIn(PRIVACY_REQUEST_TYPES as unknown as string[], {
    message: 'validation:invalidValue',
  })
  type!: PrivacyRequestType;

  /** The challenge from `POST /privacy-requests/code`. */
  @IsUUID('4', { message: 'validation:invalidValue' })
  challengeId!: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'validation:invalidValue' })
  code!: string;
}
