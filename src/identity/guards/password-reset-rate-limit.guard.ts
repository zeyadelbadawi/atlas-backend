/**
 * Redis-backed rate limiting for `POST /auth/password-reset/request` —
 * same rationale as `SignInRateLimitGuard`.
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
import { AuthRateLimiterService } from '../services/auth-rate-limiter.service';
import { normalizeEmail } from '../utils/email.util';

@Injectable()
export class PasswordResetRateLimitGuard implements CanActivate {
  constructor(
    private readonly rateLimiter: AuthRateLimiterService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    const { max, windowSeconds } = identity.passwordResetRateLimit;

    const ipCheck = await this.rateLimiter.consume(
      `password-reset:ip:${request.ip}`,
      max,
      windowSeconds,
    );

    const email =
      typeof request.body?.email === 'string'
        ? normalizeEmail(request.body.email)
        : undefined;
    const accountCheck = email
      ? await this.rateLimiter.consume(
          `password-reset:account:${email}`,
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
