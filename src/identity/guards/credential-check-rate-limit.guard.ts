/**
 * Redis-backed rate limiting for requests that CHECK A CREDENTIAL outside
 * sign-in: re-authentication with the current password (change password,
 * disable 2FA, regenerate recovery codes, disconnect Google, delete the
 * account) and confirming a password-reset link.
 *
 * A stolen access token must not become an unthrottled oracle for the
 * account's password, so a signed-in caller is metered per ACCOUNT (the
 * verified token's user, never a body value) as well as per IP; an
 * unauthenticated caller (reset confirmation) per IP. Same budget and
 * window as sign-in. Runs after `JwtAuthGuard` wherever that guards the
 * route, so `request.authContext` is already set.
 */
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { IdentityConfig } from '../../config/configuration';
import { resolveClientIp } from '../utils/request-metadata.util';
import { AuthRateLimiterService } from '../services/auth-rate-limiter.service';

@Injectable()
export class CredentialCheckRateLimitGuard implements CanActivate {
  constructor(
    private readonly rateLimiter: AuthRateLimiterService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    const { max, windowSeconds } = identity.signInRateLimit;

    const ipCheck = await this.rateLimiter.consume(
      `credential:ip:${resolveClientIp(request) ?? request.ip}`,
      max,
      windowSeconds,
    );
    const userId = request.authContext?.userId;
    const accountCheck = userId
      ? await this.rateLimiter.consume(`credential:user:${userId}`, max, windowSeconds)
      : { allowed: true, retryAfterSeconds: 0 };

    if (!ipCheck.allowed || !accountCheck.allowed) {
      throw new HttpException(
        { messageKey: 'errors.auth.rateLimited' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
