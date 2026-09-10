/**
 * TwoFactorController — `/auth/2fa/*` (Phase 10.3).
 *
 * TWO DIFFERENT AUTHORIZATION MODELS LIVE HERE, deliberately:
 *
 *  - Management routes (status, setup, confirm, disable, recovery codes)
 *    require a real session via `JwtAuthGuard`, and the destructive ones
 *    additionally require the PASSWORD at the service layer. A session
 *    alone must never be enough to remove the control that exists to make
 *    a stolen session useless.
 *
 *  - `POST /auth/2fa/verify` is PUBLIC by necessity: the caller is
 *    half-authenticated and holds no token. Its credential is the
 *    challenge id, which is single-purpose, short-lived, attempt-limited,
 *    and useless anywhere else. It additionally carries the sign-in rate
 *    limiter, because it is a login endpoint in everything but name.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../services/auth.service';
import { TwoFactorService } from '../services/two-factor.service';
import type { TwoFactorStatus } from '../services/two-factor.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import type { AuthContext } from '../guards/jwt-auth.guard';
import { CurrentAuthContext } from '../decorators/auth-context.decorator';
import { SignInRateLimitGuard } from '../guards/signin-rate-limit.guard';
import {
  ConfirmTwoFactorDto,
  DisableTwoFactorDto,
  RegenerateRecoveryCodesDto,
  VerifyTwoFactorDto,
} from '../dto/two-factor.dto';
import { resolveClientIp, resolveUserAgent } from '../utils/request-metadata.util';
import type { AuthenticationSessionContract } from '../dto/contracts';

@Controller('auth/2fa')
export class TwoFactorController {
  constructor(
    private readonly twoFactorService: TwoFactorService,
    private readonly authService: AuthService,
  ) {}

  /** Whether 2FA is on, mid-setup, and how many recovery codes remain. Never returns secret material. */
  @Get('status')
  @UseGuards(JwtAuthGuard)
  async getStatus(@CurrentAuthContext() auth: AuthContext): Promise<TwoFactorStatus> {
    return this.twoFactorService.getStatus(auth.userId);
  }

  /**
   * Begins enrolment.
   *
   * This is the ONE response that ever contains the secret in plaintext —
   * the user cannot enrol without it. It is not persisted anywhere
   * unencrypted and is never returned again.
   */
  @Post('setup')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async startSetup(@CurrentAuthContext() auth: AuthContext) {
    return this.twoFactorService.startSetup(auth.userId);
  }

  /**
   * Completes enrolment by proving a valid code, and returns the recovery
   * codes — also shown exactly once.
   */
  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async confirmSetup(
    @CurrentAuthContext() auth: AuthContext,
    @Body() dto: ConfirmTwoFactorDto,
  ): Promise<{ recoveryCodes: string[] }> {
    return this.twoFactorService.confirmSetup(auth.userId, dto.token);
  }

  /**
   * Completes a sign-in that stopped for a second factor.
   *
   * Public — the caller has no session yet, by design. Rate-limited with
   * the sign-in guard because that is exactly what this is.
   */
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SignInRateLimitGuard)
  async verify(
    @Req() request: Request,
    @Body() dto: VerifyTwoFactorDto,
  ): Promise<AuthenticationSessionContract> {
    return this.authService.completeTwoFactorSignIn(
      dto.challengeId,
      { token: dto.token, recoveryCode: dto.recoveryCode },
      {
        ipAddress: resolveClientIp(request),
        userAgent: resolveUserAgent(request),
      },
    );
  }

  /** Turns 2FA off. Requires the password — a session alone is not enough. */
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  async disable(
    @CurrentAuthContext() auth: AuthContext,
    @Body() dto: DisableTwoFactorDto,
  ): Promise<void> {
    await this.twoFactorService.disable(auth.userId, dto.password);
  }

  /** Issues a new set of recovery codes and invalidates every old one. Password-gated for the same reason as disable. */
  @Post('recovery-codes')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async regenerateRecoveryCodes(
    @CurrentAuthContext() auth: AuthContext,
    @Body() dto: RegenerateRecoveryCodesDto,
  ): Promise<{ recoveryCodes: string[] }> {
    return this.twoFactorService.regenerateRecoveryCodes(auth.userId, dto.password);
  }
}
