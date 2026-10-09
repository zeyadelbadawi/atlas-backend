import { IsString, Matches, MaxLength } from 'class-validator';

/** Body of `POST /learning/watermarks/tamper` — the code the player was drawing. */
export class WatermarkTamperDto {
  @IsString()
  @MaxLength(16)
  @Matches(/^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z-]+$/)
  code!: string;
}
