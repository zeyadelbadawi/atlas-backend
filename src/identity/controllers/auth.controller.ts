/**
 * AuthController — `/auth/*` (master plan §10: "Auth | `/auth/*` | public
 * (register, reset) / session (refresh, sign-out)").
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from '../services/auth.service';
import { RegisterDto } from '../dto/register.dto';
import { SignInDto } from '../dto/sign-in.dto';
import { RefreshTokenDto } from '../dto/refresh-token.dto';
import { PasswordResetRequestDto } from '../dto/password-reset-request.dto';
import { PasswordResetConfirmDto } from '../dto/password-reset-confirm.dto';
import type {
  AuthenticationResponseContract,
  TokenRefreshResponseContract,
} from '../dto/contracts';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { CurrentAuthContext } from '../decorators/auth-context.decorator';
import type { AuthContext } from '../guards/jwt-auth.guard';
import { SignInRateLimitGuard } from '../guards/signin-rate-limit.guard';
import { PasswordResetRateLimitGuard } from '../guards/password-reset-rate-limit.guard';
import { RegisterRateLimitGuard } from '../guards/register-rate-limit.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** Matches `authenticationService.register` — does not establish a session. */
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RegisterRateLimitGuard)
  async register(@Body() dto: RegisterDto): Promise<void> {
    await this.authService.register(dto);
  }

  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SignInRateLimitGuard)
  async signIn(@Body() dto: SignInDto): Promise<AuthenticationResponseContract> {
    return this.authService.signIn(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshTokenDto): Promise<TokenRefreshResponseContract> {
    return this.authService.refresh(dto.refreshToken);
  }

  /** Matches `authenticationService.signOut` — no body; the session to revoke comes from the access token's `sid` claim. See `AccessTokenService`'s doc comment. */
  @Post('sign-out')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async signOut(@CurrentAuthContext() auth: AuthContext): Promise<void> {
    await this.authService.signOut(auth.userId, auth.sessionId);
  }

  /** Matches `authenticationService.validateSession` — reaching the handler at all means the guard already verified the token. */
  @Get('validate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  validate(): void {
    this.authService.validateSession();
  }

  @Post('password-reset/request')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PasswordResetRateLimitGuard)
  async requestPasswordReset(@Body() dto: PasswordResetRequestDto): Promise<void> {
    await this.authService.requestPasswordReset(dto.email);
  }

  @Post('password-reset/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmPasswordReset(@Body() dto: PasswordResetConfirmDto): Promise<void> {
    await this.authService.confirmPasswordReset(dto.token, dto.newPassword);
  }
}
