/**
 * EmailOtpController — `/auth/otp/*` (P64 Communications C4).
 *
 * BOTH ROUTES ARE PUBLIC BY NECESSITY, exactly as `POST /auth/2fa/verify`
 * is: the caller is half-authenticated and holds no token. Their
 * credential is the challenge reference, which is single-purpose,
 * short-lived, attempt-limited, tamper-evident and useless anywhere else
 * — and, for `verify`, the emailed code on top of it.
 *
 * Both therefore also carry `SignInRateLimitGuard`, because they are
 * login endpoints in everything but name. Note what that guard actually
 * covers here: the body carries no `email`, so only its per-IP budget
 * applies. The per-ACCOUNT budgets that matter for this flow live in
 * `EmailOtpService` (5 challenges/hour per account, 3 codes per
 * challenge, 60s between codes, 5 verify attempts per challenge), where
 * the account is known from the challenge rather than from the request.
 *
 * The `atlas_trust` cookie is read from the real `Cookie` header and
 * written to the response here, never passed through the body — setting
 * it is an HTTP concern, and accepting it from the body would let a
 * client nominate its own trusted device.
 */
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from '../services/auth.service';
import { EmailOtpService } from '../services/email-otp.service';
import { SignInRateLimitGuard } from '../guards/signin-rate-limit.guard';
import { ResendEmailOtpDto, VerifyEmailOtpDto } from '../dto/email-otp.dto';
import type {
  AuthenticationSessionContract,
  EmailOtpResendContract,
} from '../dto/contracts';
import { resolveClientIp, resolveUserAgent } from '../utils/request-metadata.util';
import { deviceCookieOptions, readCookie } from '../../common/http/cookies.util';
import { DEVICE_COOKIE_NAME } from '../../tenancy/services/student-device.service';
import { TRUST_COOKIE_NAME } from '../services/trusted-device.service';

@Controller('auth/otp')
export class EmailOtpController {
  constructor(
    private readonly authService: AuthService,
    private readonly emailOtpService: EmailOtpService,
  ) {}

  /**
   * Completes a sign-in that stopped for an emailed code.
   *
   * Mints the session through the same `issueSession` path as the
   * password-only and 2FA routes, so a session created here is shaped
   * identically — including the learner device registration, which is
   * why `deviceCookie`/`onDeviceCookie` are threaded through exactly as
   * `TwoFactorController.verify` threads them. Omitting them would give
   * every OTP-protected learner a session with no device and a permanent
   * content refusal.
   */
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SignInRateLimitGuard)
  async verify(
    @Req() request: Request,
    @Body() dto: VerifyEmailOtpDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthenticationSessionContract> {
    return this.authService.completeEmailOtpSignIn(
      dto.challengeId,
      dto.code,
      dto.rememberDevice,
      {
        ipAddress: resolveClientIp(request),
        userAgent: resolveUserAgent(request),
        hostname: request.hostname,
        deviceCookie: readCookie(request.headers.cookie, DEVICE_COOKIE_NAME),
        onDeviceCookie: (value, maxAgeSeconds) => {
          response.cookie(
            DEVICE_COOKIE_NAME,
            value,
            deviceCookieOptions({ secure: request.secure, maxAgeSeconds }),
          );
        },
        // Read from the real header so a browser that is re-proving an
        // expired or revoked trust replaces its own row rather than
        // accumulating one per sign-in.
        trustCookie: readCookie(request.headers.cookie, TRUST_COOKIE_NAME),
        onTrustCookie: (value, maxAgeSeconds) => {
          response.cookie(
            TRUST_COOKIE_NAME,
            value,
            // `httpOnly` + `sameSite: lax` + `secure` off only on plain
            // local HTTP — the same attributes, and the same reasoning,
            // as the device cookie; see `cookies.util.ts`.
            deviceCookieOptions({ secure: request.secure, maxAgeSeconds }),
          );
        },
      },
    );
  }

  /**
   * Sends a fresh code for the same challenge.
   *
   * Answers only the next cooldown and how many codes remain — never the
   * new expiry, and obviously never the code. The frontend hides its
   * expiry countdown after a resend for exactly that reason rather than
   * showing a stale one.
   */
  @Post('resend')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SignInRateLimitGuard)
  async resend(
    @Req() request: Request,
    @Body() dto: ResendEmailOtpDto,
  ): Promise<EmailOtpResendContract> {
    const result = await this.emailOtpService.resend(dto.challengeId, {
      ipAddress: resolveClientIp(request),
      userAgent: resolveUserAgent(request),
    });
    return {
      resendAvailableAt: result.resendAvailableAt.toISOString(),
      resendsRemaining: result.resendsRemaining,
    };
  }
}
