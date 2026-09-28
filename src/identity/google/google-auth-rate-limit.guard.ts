/**
 * Google Identity — per-IP budget for starting and completing Google
 * sign-ins, on the same Redis limiter and the same sign-in budget numbers as
 * `SignInRateLimitGuard` (under its own keys: a Google attempt carries no
 * email to meter by, and must not eat the password budget).
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
import { recordGoogleAuth } from '../../observability/metrics/google-auth-metrics';

@Injectable()
export class GoogleAuthRateLimitGuard implements CanActivate {
  constructor(
    private readonly rateLimiter: AuthRateLimiterService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const { max, windowSeconds } =
      this.configService.getOrThrow<IdentityConfig>('identity').signInRateLimit;
    // Starting and completing are metered apart: a completion follows every
    // start, and must not halve the budget a person gets.
    const stage = request.path.endsWith('/complete') ? 'complete' : 'authorize';
    const check = await this.rateLimiter.consume(
      `google:${stage}:ip:${resolveClientIp(request) ?? request.ip}`,
      max * 2,
      windowSeconds,
    );
    if (!check.allowed) {
      recordGoogleAuth(stage, 'rate_limited');
      throw new HttpException(
        { messageKey: 'errors.auth.rateLimited' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
