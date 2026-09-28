/** `POST /auth/refresh` request — matches `TokenRefreshRequest`. */
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RefreshTokenDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(512)
  readonly refreshToken!: string;
}
