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
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
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
import type { SessionRequestContext } from '../services/auth.service';
import { resolveClientIp, resolveUserAgent } from '../utils/request-metadata.util';
import type { UserSessionResponse } from '../dto/user-session.contract';

/** Real, server-resolved request metadata for a session write. See `request-metadata.util.ts` for the trust model behind these headers. */
function sessionContext(request: Request): SessionRequestContext {
  return {
    ipAddress: resolveClientIp(request),
    userAgent: resolveUserAgent(request),
  };
}

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
  async signIn(
    @Body() dto: SignInDto,
    @Req() request: Request,
  ): Promise<AuthenticationResponseContract> {
    // Phase 10 — device/IP are resolved from the real request here, never
    // accepted from `dto`, so a client cannot label or locate its own
    // session however it likes.
    return this.authService.signIn({ ...dto, context: sessionContext(request) });
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() request: Request,
  ): Promise<TokenRefreshResponseContract> {
    // Re-read on every refresh so `lastUsedAt` tracks genuine session
    // activity rather than only the original sign-in.
    return this.authService.refresh(dto.refreshToken, sessionContext(request));
  }

  /** Matches `authenticationService.signOut` — no body; the session to revoke comes from the access token's `sid` claim. See `AccessTokenService`'s doc comment. */
  @Post('sign-out')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async signOut(@CurrentAuthContext() auth: AuthContext): Promise<void> {
    await this.authService.signOut(auth.userId, auth.sessionId);
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
  async requestPasswordReset(@Body() dto: PasswordResetRequestDto): Promise<void> {
    await this.authService.requestPasswordReset(dto.email);
  }

  @Post('password-reset/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmPasswordReset(@Body() dto: PasswordResetConfirmDto): Promise<void> {
    await this.authService.confirmPasswordReset(dto.token, dto.newPassword);
  }
}
