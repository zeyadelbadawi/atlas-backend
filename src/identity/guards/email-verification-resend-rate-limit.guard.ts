/**
 * Redis-backed rate limiting for `POST /auth/verify-email/resend`.
 *
 * Its own counters, keyed per ACCOUNT and per client IP. The route used to
 * borrow `PasswordResetRateLimitGuard`, which keyed by IP alone (the body
 * carries no email here, so its per-account half never applied) and shared
 * the `password-reset:*` budget — a few resends locked the same network out
 * of password recovery, and an account could be resent to from many
 * addresses without any per-account ceiling at all.
 *
 * Must run AFTER `JwtAuthGuard`: the account key is the authenticated
 * user id, never anything taken from the request body.
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
export class EmailVerificationResendRateLimitGuard implements CanActivate {
  constructor(
    private readonly rateLimiter: AuthRateLimiterService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    const { max, ipMax, windowSeconds } = identity.emailVerificationResendRateLimit;

    const ipCheck = await this.rateLimiter.consume(
      `email-verification-resend:ip:${resolveClientIp(request) ?? request.ip}`,
      ipMax,
      windowSeconds,
    );

    const userId = request.authContext?.userId;
    const accountCheck = userId
      ? await this.rateLimiter.consume(
          `email-verification-resend:user:${userId}`,
          max,
          windowSeconds,
        )
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
