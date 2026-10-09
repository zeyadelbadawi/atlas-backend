/**
 * AuthController — `/auth/*` (master plan §10: "Auth | `/auth/*` | public
 * (register, reset) / session (refresh, sign-out)").
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService } from '../services/auth.service';
import { RegisterDto } from '../dto/register.dto';
import { AcademyJoinDto } from '../dto/academy-join.dto';
import { SignInDto } from '../dto/sign-in.dto';
import { RefreshTokenDto } from '../dto/refresh-token.dto';
import { PasswordResetRequestDto } from '../dto/password-reset-request.dto';
import { PasswordResetValidateDto } from '../dto/password-reset-validate.dto';
import { PasswordResetConfirmDto } from '../dto/password-reset-confirm.dto';
import { VerifyEmailDto } from '../dto/verify-email.dto';
import type {
  AuthenticationResponseContract,
  TokenRefreshResponseContract,
} from '../dto/contracts';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../guards/optional-jwt-auth.guard';
import { CurrentAuthContext } from '../decorators/auth-context.decorator';
import type { AuthContext } from '../guards/jwt-auth.guard';
import { SignInRateLimitGuard } from '../guards/signin-rate-limit.guard';
import { PasswordResetRateLimitGuard } from '../guards/password-reset-rate-limit.guard';
import { EmailVerificationResendRateLimitGuard } from '../guards/email-verification-resend-rate-limit.guard';
import { RegisterRateLimitGuard } from '../guards/register-rate-limit.guard';
import { CredentialCheckRateLimitGuard } from '../guards/credential-check-rate-limit.guard';
import type {
  AcademyJoinResult,
  AcademyJoinSummary,
  RegistrationResult,
  SessionRequestContext,
} from '../services/auth.service';
import {
  resolveClientCountry,
  resolveClientIp,
  resolveUserAgent,
} from '../utils/request-metadata.util';
import type { UserSessionResponse } from '../dto/user-session.contract';
import { deviceCookieOptions, readCookie } from '../../common/http/cookies.util';
import {
  assertSameOriginCookieRequest,
  clearSessionCookie,
  readSessionCookie,
} from '../session-cookie/session-cookie';
import { DEVICE_COOKIE_NAME } from '../../tenancy/services/student-device.service';
import { TRUST_COOKIE_NAME } from '../services/trusted-device.service';
import { assertSessionServesHostAcademy } from '../../learning/dto/learning-request.util';
import { SupersededRefreshTokenException } from '../errors/superseded-refresh-token.exception';

/** Real, server-resolved request metadata for a session write. See `request-metadata.util.ts` for the trust model behind these headers. */
export function sessionContext(request: Request): SessionRequestContext {
  return {
    ipAddress: resolveClientIp(request),
    userAgent: resolveUserAgent(request),
    locationCountry: resolveClientCountry(request),
    // P64 Phase 1 — the host the edge routed to (Express strips the port).
    hostname: request.hostname,
    // P64 Phase 2 (AD-10) — read from the real `Cookie` header, never from
    // the body, so a client cannot name its own device row.
    deviceCookie: readCookie(request.headers.cookie, DEVICE_COOKIE_NAME),
    // P64 Communications C4 (§12) — the `atlas_trust` cookie, read from
    // the real `Cookie` header for the same reason: a client must not be
    // able to nominate itself as a trusted device. It is consulted only
    // AFTER the password has been verified, and at most removes the
    // emailed code from a sign-in that has already succeeded.
    trustCookie: readCookie(request.headers.cookie, TRUST_COOKIE_NAME),
  };
}

/**
 * Adds the "write the device cookie if a new device was registered" hook.
 *
 * `secure` follows the request's own protocol rather than `NODE_ENV`: the
 * production edge terminates TLS and forwards `x-forwarded-proto`, which
 * Express resolves into `request.secure` because `trust proxy` is set
 * (`main.ts`), and a `Secure` cookie over plain local HTTP is silently
 * dropped by every browser — which would mean the feature quietly did not
 * work for developers while appearing to.
 */
export function sessionContextWithDeviceCookie(
  request: Request,
  response: Response,
): SessionRequestContext {
  return {
    ...sessionContext(request),
    onDeviceCookie: (value, maxAgeSeconds) => {
      response.cookie(
        DEVICE_COOKIE_NAME,
        value,
        deviceCookieOptions({ secure: request.secure, maxAgeSeconds }),
      );
    },
  };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** Matches `authenticationService.register` — does not establish a session. */
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RegisterRateLimitGuard)
  async register(
    @Body() dto: RegisterDto,
    @Req() request: Request,
  ): Promise<RegistrationResult> {
    // Launch Stabilization A4 — `{ account: 'existing' }` when an academy
    // signup added this academy to an account that already existed (its own
    // password proven); `{ account: 'new' }` otherwise. Still no session.
    return this.authService.register({
      ...dto,
      hostname: request.hostname,
      // Forensic only — recorded on a signup trial's redemption, exactly as
      // `POST /organizations/:id/subscription/trial` records it.
      context: {
        ipAddress: resolveClientIp(request),
        userAgent: resolveUserAgent(request),
      },
    });
  }

  /**
   * Smart academy signup — an existing Atlas account joins this academy as
   * a learner, proven by its own password. Metered and answered exactly
   * like `sign-in` (same guard, same generic 401), so it is not an
   * account-existence oracle. Establishes no session: the caller signs in
   * next, under the academy's emailed-code and trusted-device rules.
   */
  @Post('academy-join')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SignInRateLimitGuard)
  async academyJoin(
    @Body() dto: AcademyJoinDto,
    @Req() request: Request,
  ): Promise<AcademyJoinResult> {
    return this.authService.joinAcademy({ ...dto, hostname: request.hostname });
  }

  /**
   * Smart academy signup — the other academies an existing account already
   * belongs to, for the "you already use Atlas with …" confirmation. Only a
   * signed-in academy session, on the academy it joined minutes ago, gets a
   * non-empty answer (see `AuthService.academyJoinSummary`).
   */
  @Get('academy-join/summary')
  @UseGuards(JwtAuthGuard)
  async academyJoinSummary(
    @CurrentAuthContext() auth: AuthContext,
    @Req() request: Request,
  ): Promise<AcademyJoinSummary> {
    const hostAcademyId = await this.authService.hostAcademyId(request.hostname);
    // A1 — an academy session is answered only on its own academy's host.
    assertSessionServesHostAcademy(request, hostAcademyId);
    return this.authService.academyJoinSummary(auth, hostAcademyId);
  }

  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SignInRateLimitGuard)
  async signIn(
    @Body() dto: SignInDto,
    @Req() request: Request,
    // `passthrough` so Nest still serialises the returned contract — the
    // response object is needed only to set the device cookie.
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthenticationResponseContract> {
    // Phase 10 — device/IP are resolved from the real request here, never
    // accepted from `dto`, so a client cannot label or locate its own
    // session however it likes.
    return this.authService.signIn({
      ...dto,
      context: sessionContextWithDeviceCookie(request, response),
    });
  }

  /**
   * Rotates the session. The refresh token comes from the HttpOnly session
   * cookie (same-origin requests only); the new one goes back into it via
   * `SessionCookieInterceptor`, and only the short-lived access token is in
   * the body. A failed refresh clears the cookie, so a dead session does not
   * keep being presented.
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TokenRefreshResponseContract> {
    const fromCookie = readSessionCookie(request);
    if (fromCookie) assertSameOriginCookieRequest(request);
    const presented = fromCookie ?? dto.refreshToken;
    if (!presented) {
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidRefreshToken' });
    }
    try {
      // Re-read on every refresh so `lastUsedAt` tracks genuine session
      // activity rather than only the original sign-in.
      return await this.authService.refresh(presented, sessionContext(request));
    } catch (error) {
      // A refused refresh clears the cookie — except one that merely lost a
      // race to a concurrent refresh: the browser already holds the newer
      // cookie, and clearing it would sign every tab out of a valid session.
      if (fromCookie && !(error instanceof SupersededRefreshTokenException)) {
        clearSessionCookie(request, response);
      }
      throw error;
    }
  }

  /**
   * Ends the session. Identified by the access token's `sid` when one is
   * presented, otherwise by the session cookie (same-origin only) — so a
   * browser whose in-memory access token has lapsed can still sign out
   * properly. The cookie is always cleared, and the answer is always 200:
   * signing out of something already gone is not an error.
   */
  @Post('sign-out')
  @HttpCode(HttpStatus.OK)
  @UseGuards(OptionalJwtAuthGuard)
  async signOut(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const auth = request.authContext;
    const fromCookie = readSessionCookie(request);
    if (auth) {
      await this.authService.signOut(auth.userId, auth.sessionId);
    } else if (fromCookie) {
      assertSameOriginCookieRequest(request);
      await this.authService.signOutByRefreshToken(fromCookie);
    }
    clearSessionCookie(request, response);
  }

  /**
   * Phase 10.1 — completes email verification.
   *
   * Requires the account's own session alongside the emailed token: a link
   * opened without it is refused with `verificationSignInRequired` and NOT
   * spent, so the owner can sign in and finish. Strictly single-use
   * underneath — a replayed token matches zero rows and is refused with
   * a generic error. Unknown and malformed tokens are indistinguishable,
   * so this endpoint cannot be used to probe which tokens exist; only the
   * holder of a REAL link is told it expired or was already used.
   *
   * 10 attempts per minute per client IP, in place of the global 120/min: a
   * person clicks a link once or twice, and a 256-bit token cannot be
   * guessed, so the ceiling only bounds scripted hammering of the
   * endpoint (each attempt costs a hash lookup and a transaction).
   */
  @Post('verify-email')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @UseGuards(OptionalJwtAuthGuard)
  async verifyEmail(@Body() dto: VerifyEmailDto, @Req() request: Request): Promise<void> {
    // The link completes only for the account's own session (ATO F1
    // follow-up, see `EmailVerificationTokensRepository.consume`).
    await this.authService.verifyEmail(dto.token, request.authContext?.userId ?? null);
  }

  /**
   * Phase 10.1 — re-sends verification for the signed-in account.
   *
   * Its own per-account and per-IP budget
   * (`EmailVerificationResendRateLimitGuard`): this endpoint sends mail on
   * demand, which is exactly the shape that gets abused as a free mail
   * relay if left open. The session's surface decides where the new link
   * points — an academy-website session gets its academy's verify page.
   */
  @Post('verify-email/resend')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(JwtAuthGuard, EmailVerificationResendRateLimitGuard)
  async resendEmailVerification(@CurrentAuthContext() auth: AuthContext): Promise<void> {
    await this.authService.resendEmailVerification(auth.userId, {
      academyId: auth.surface === 'academy' ? auth.academyId : null,
    });
  }

  /**
   * Phase 10 — the caller's OWN active sessions/devices.
   *
   * There is no user id in the path or query by design: the list is
   * derived from the access token's verified `sub`, so there is no
   * parameter for a caller to change in order to read somebody else's
   * sessions. Organization or Academy role is irrelevant here and is
   * never consulted — no membership makes another user's devices
   * visible.
   *
   * The response carries no token material of any kind; see
   * `user-session.contract.ts`.
   */
  @Get('sessions')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async listSessions(
    @CurrentAuthContext() auth: AuthContext,
  ): Promise<readonly UserSessionResponse[]> {
    return this.authService.listSessions(auth.userId, auth.sessionId);
  }

  /**
   * Phase 10 — revokes one of the caller's own sessions.
   *
   * `:id` is a session id, and the service scopes the revocation by the
   * authenticated user, so supplying another user's session id revokes
   * nothing and reports not-found rather than confirming that the id
   * exists.
   *
   * Revocation is immediate in the real token-validation path, not just
   * in the database — see `SessionRevocationService`.
   */
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  async revokeSession(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id') sessionId: string,
  ): Promise<void> {
    await this.authService.revokeSession(auth.userId, sessionId);
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
  async requestPasswordReset(
    @Body() dto: PasswordResetRequestDto,
    @Req() request: Request,
  ): Promise<void> {
    // The host the request reached decides which surface the emailed link
    // returns to — never a body field, so a caller cannot ask for another
    // academy's branding.
    await this.authService.requestPasswordReset(dto.email, {
      hostname: request.hostname,
    });
  }

  /**
   * P64 Phase 1 — lets the reset page check a token before the user types a
   * new password (previously it accepted any non-empty token and only found
   * out on submit). Public like `confirm`; reveals only whether THIS token is
   * currently valid, never who it belongs to.
   */
  @Post('password-reset/validate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PasswordResetRateLimitGuard)
  async validatePasswordReset(
    @Body() dto: PasswordResetValidateDto,
  ): Promise<{ valid: boolean }> {
    return { valid: await this.authService.isPasswordResetTokenValid(dto.token) };
  }

  @Post('password-reset/confirm')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CredentialCheckRateLimitGuard)
  async confirmPasswordReset(
    @Body() dto: PasswordResetConfirmDto,
    @Req() request: Request,
  ): Promise<void> {
    await this.authService.confirmPasswordReset(dto.token, dto.newPassword, {
      hostname: request.hostname,
    });
  }
}
