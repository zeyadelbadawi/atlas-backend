/**
 * Redis-backed rate limiting for `POST /auth/sign-in` and the routes that
 * prove a password or a sign-in code the same way. The budgets themselves —
 * per IP, per account from one network, and an account-wide ceiling on
 * failures that a known browser is exempt from — live in
 * `SignInThrottleService` (ATO review F7: no attacker can lock an owner out
 * of their own account from elsewhere).
 */
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
} from '@nestjs/common';
import type { Request } from 'express';
import { readCookie } from '../../common/http/cookies.util';
import { resolveClientIp } from '../utils/request-metadata.util';
import { normalizeEmail } from '../utils/email.util';
import {
  SignInThrottleService,
  knownDeviceCookieName,
} from '../services/sign-in-throttle.service';
import { SecurityEventsService } from '../../security-events/services/security-events.service';

@Injectable()
export class SignInRateLimitGuard implements CanActivate {
  constructor(
    private readonly throttle: SignInThrottleService,
    /** W3 — OTP & Security Monitoring (pre-auth: hashed subject and IP only). */
    @Optional() private readonly securityEvents?: SecurityEventsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const ipAddress = resolveClientIp(request) ?? request.ip;
    const email =
      typeof request.body?.email === 'string'
        ? normalizeEmail(request.body.email)
        : undefined;

    const refusal = await this.throttle.check({
      email,
      ipAddress,
      knownDeviceCookie: readCookie(
        request.headers.cookie,
        knownDeviceCookieName(request.secure),
      ),
    });

    if (refusal) {
      // Pre-auth: nothing here proves who is asking, so no user id — only
      // keyed hashes of the typed address and the client IP, folded into
      // one row per minute by the writer.
      await this.securityEvents?.record({
        type: 'signin_rate_limited',
        surface: request.body?.surface === 'academy' ? 'academy' : 'management',
        email,
        ipAddress,
        reason: refusal,
      });
      throw new HttpException(
        { messageKey: 'errors.auth.rateLimited' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
