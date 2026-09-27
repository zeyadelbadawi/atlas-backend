import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/** `POST /auth/google/authorize`. The surface and academy come from the HOST. */
export class GoogleAuthorizeDto {
  @IsIn(['sign_in', 'sign_up'])
  readonly intent!: 'sign_in' | 'sign_up';

  /** A relative path to land on afterwards; anything else is dropped. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  readonly returnTo?: string;

  /** Platform host / local development only (the preview parameter); refused on a mismatching academy host. */
  @IsOptional()
  @IsUUID()
  readonly academyId?: string;
}

/** `POST /auth/google/complete` — the single-use handoff from the URL fragment. */
export class GoogleCompleteDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(128)
  readonly handoff!: string;
}
