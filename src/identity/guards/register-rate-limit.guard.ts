/**
 * Redis-backed rate limiting for `POST /auth/register` (Phase P18 — see
 * `env.validation.ts`'s own doc comment: this endpoint had no dedicated
 * limit before this phase, only the generic global default). Same
 * mechanism/shape as `SignInRateLimitGuard`/`PasswordResetRateLimitGuard`
 * — IP-keyed only (there is no "account" to key a SECOND check by until
 * after the account is created, unlike sign-in/password-reset, which
 * already have a real email to check against).
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

@Injectable()
export class RegisterRateLimitGuard implements CanActivate {
  constructor(
    private readonly rateLimiter: AuthRateLimiterService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    const { max, windowSeconds } = identity.registerRateLimit;

    const ipCheck = await this.rateLimiter.consume(
      `register:ip:${request.ip}`,
      max,
      windowSeconds,
    );

    if (!ipCheck.allowed) {
      throw new HttpException(
        { messageKey: 'errors.auth.rateLimited' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
