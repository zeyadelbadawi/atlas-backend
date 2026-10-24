/**
 * Atlas mobile app (B4) — what a person accepted, as the client showed it.
 *
 * Used on its own (`POST /users/me/consents`) and nested, optionally, in
 * `POST /auth/register` as `consents`. The web never sends it, so the
 * web's requests are unchanged.
 */
import { Equals, IsIn, IsString, Matches } from 'class-validator';

export const CONSENT_SOURCES = ['web', 'ios', 'android'] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

/** Same rule as the `user_consents_version_format` CHECK. */
export const CONSENT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class ConsentsDto {
  @IsIn(CONSENT_SOURCES)
  readonly source!: ConsentSource;

  /** The Terms of Service version shown, e.g. `terms-2026-10`. */
  @IsString()
  @Matches(CONSENT_VERSION_PATTERN)
  readonly termsVersion!: string;

  /** The Privacy Policy version shown, e.g. `privacy-2026-10`. */
  @IsString()
  @Matches(CONSENT_VERSION_PATTERN)
  readonly privacyVersion!: string;

  /** "I am 13 or older" — Atlas's minimum age. Only `true` is accepted. */
  @Equals(true)
  readonly ageConfirmed!: true;
}
