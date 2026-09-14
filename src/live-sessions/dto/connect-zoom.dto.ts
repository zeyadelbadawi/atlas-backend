/**
 * Zoom connection credentials.
 *
 * WHAT THESE ARE. The values an academy copies from their own Zoom apps:
 * a Server-to-Server OAuth app (account id + client id + client secret)
 * for the REST API, and optionally a Meeting SDK app (key + secret) for
 * the embedded join, plus the webhook secret token.
 *
 * THEY ARE WRITE-ONLY. Nothing in this feature ever reads them back out
 * to a client — there is no GET that returns them, by design.
 *
 * Length bounds are deliberately generous rather than exact: Zoom has
 * changed credential formats before, and a too-clever regex would reject
 * a valid new-format secret and look like a Zoom outage.
 */
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class ConnectZoomDto {
  @IsString()
  @MinLength(1, { message: 'validation:required' })
  @MaxLength(200, { message: 'validation:maxLength' })
  accountId!: string;

  @IsString()
  @MinLength(1, { message: 'validation:required' })
  @MaxLength(200, { message: 'validation:maxLength' })
  clientId!: string;

  @IsString()
  @MinLength(1, { message: 'validation:required' })
  @MaxLength(500, { message: 'validation:maxLength' })
  clientSecret!: string;

  /** Required for the EMBEDDED join; without it sessions can be created but not joined in-app. */
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: 'validation:maxLength' })
  sdkKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'validation:maxLength' })
  sdkSecret?: string;

  /** Required for attendance and recording events to be accepted at all. */
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'validation:maxLength' })
  webhookSecretToken?: string;
}
