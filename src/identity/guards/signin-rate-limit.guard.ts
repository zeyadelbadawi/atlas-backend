/**
 * Redis-backed rate limiting for `POST /auth/sign-in` — per-IP and
 * per-account (normalized email), both independently enforced (master plan
 * §8 "Brute-force protection", §16, §21 P1 requirement #9/#20).
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
export class SignInRateLimitGuard implements CanActivate {
  constructor(
    private readonly rateLimiter: AuthRateLimiterService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    const { max, windowSeconds } = identity.signInRateLimit;

    const ipCheck = await this.rateLimiter.consume(
      `signin:ip:${request.ip}`,
      max,
      windowSeconds,
    );

    const email =
      typeof request.body?.email === 'string'
        ? normalizeEmail(request.body.email)
        : undefined;
    const accountCheck = email
      ? await this.rateLimiter.consume(`signin:account:${email}`, max, windowSeconds)
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
