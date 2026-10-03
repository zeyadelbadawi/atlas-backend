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
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { IdentityConfig } from '../../config/configuration';
import { resolveClientIp } from '../utils/request-metadata.util';
import { AuthRateLimiterService } from '../services/auth-rate-limiter.service';
import { normalizeEmail } from '../utils/email.util';
import { SecurityEventsService } from '../../security-events/services/security-events.service';

@Injectable()
export class SignInRateLimitGuard implements CanActivate {
  constructor(
    private readonly rateLimiter: AuthRateLimiterService,
    private readonly configService: ConfigService,
    /** W3 — OTP & Security Monitoring (pre-auth: hashed subject and IP only). */
    @Optional() private readonly securityEvents?: SecurityEventsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    const { max, windowSeconds } = identity.signInRateLimit;

    const ipCheck = await this.rateLimiter.consume(
      `signin:ip:${resolveClientIp(request) ?? request.ip}`,
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
      // Pre-auth: nothing here proves who is asking, so no user id — only
      // keyed hashes of the typed address and the client IP, folded into
      // one row per minute by the writer.
      await this.securityEvents?.record({
        type: 'signin_rate_limited',
        surface: request.body?.surface === 'academy' ? 'academy' : 'management',
        email,
        ipAddress: resolveClientIp(request) ?? request.ip,
        reason: ipCheck.allowed ? 'account_budget' : 'ip_budget',
      });
      throw new HttpException(
        { messageKey: 'errors.auth.rateLimited' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
