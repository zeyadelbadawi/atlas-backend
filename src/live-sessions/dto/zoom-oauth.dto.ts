/**
 * The authorization hand-off body.
 *
 * WHY THIS IS A POST BODY AND NOT A QUERY STRING ON A REDIRECT. Zoom
 * returns the customer's browser to Atlas as a top-level navigation, and
 * Atlas authenticates with a bearer token held by the SPA — a navigation
 * carries no `Authorization` header, so an API endpoint receiving that
 * navigation directly could never know who the caller was. Zoom therefore
 * returns to the Atlas *page*, and the page forwards these two values on
 * an ordinary authenticated request. See `LiveProviderOAuthController`.
 *
 * NEITHER VALUE IS TRUSTED. `state` is matched against a server-side row
 * that decides which academy is being connected; `code` is only ever
 * handed to Zoom. Nothing here is logged.
 */
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Generous bounds rather than exact ones: these are opaque provider
 * strings whose length Zoom is free to change. The limit exists to reject
 * an absurd payload, not to guess a format.
 */
export const ZOOM_OAUTH_CODE_MAX = 2048;
export const ZOOM_OAUTH_STATE_MAX = 512;

export class CompleteZoomAuthorizationDto {
  @IsString()
  @MinLength(1, { message: 'validation:required' })
  @MaxLength(ZOOM_OAUTH_CODE_MAX, { message: 'validation:maxLength' })
  code!: string;

  @IsString()
  @MinLength(1, { message: 'validation:required' })
  @MaxLength(ZOOM_OAUTH_STATE_MAX, { message: 'validation:maxLength' })
  state!: string;
}
