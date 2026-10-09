/**
 * SessionCookieInterceptor — the ONE place a refresh token leaves the server.
 *
 * Every endpoint that mints or rotates a session (password sign-in, the
 * emailed code, TOTP, Google completion and its steps, academy join, refresh)
 * builds its response through `AuthService.issueSession` / `refresh`, which
 * put the new refresh token on the contract. This global interceptor takes it
 * OFF the contract and puts it in the HttpOnly session cookie instead, for
 * every route, unconditionally:
 *
 *   - no endpoint — present or future — can put a refresh token where
 *     JavaScript can read it, because none gets past this interceptor;
 *   - there is deliberately no "keep it in the body" mode: a client-selected
 *     compatibility switch would let an injected script call `/auth/refresh`
 *     (the browser attaches the cookie) and read the next token from the body.
 *
 * Registered as an APP_INTERCEPTOR, so it also runs for controllers outside
 * the identity module.
 */
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { map, type Observable } from 'rxjs';
import type { IdentityConfig } from '../../config/configuration';
import { setSessionCookie } from './session-cookie';
import {
  KNOWN_DEVICE_COOKIE_MAX_AGE_DAYS,
  SignInThrottleService,
  knownDeviceCookieName,
} from '../services/sign-in-throttle.service';

@Injectable()
export class SessionCookieInterceptor implements NestInterceptor {
  constructor(
    private readonly configService: ConfigService,
    private readonly signInThrottle: SignInThrottleService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      map((body: unknown) => {
        if (
          !body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          typeof (body as { refreshToken?: unknown }).refreshToken !== 'string'
        ) {
          return body;
        }
        const { refreshToken, ...rest } = body as { refreshToken: string };
        const identity = this.configService.getOrThrow<IdentityConfig>('identity');
        setSessionCookie(
          request,
          response,
          refreshToken,
          identity.refreshTokenTtlDays * 24 * 60 * 60,
        );
        // ATO F7 — a sign-in (a session minted for a named account, not a
        // refresh) marks this browser as one that has signed in to that
        // account: it keeps its own throttle budget if the address is ever
        // under a guessing campaign. Grants nothing else.
        const email = (rest as { user?: { email?: unknown } }).user?.email;
        if (typeof email === 'string') {
          response.cookie(
            knownDeviceCookieName(request.secure),
            this.signInThrottle.mintKnownDevice(email),
            {
              httpOnly: true,
              secure: request.secure,
              sameSite: 'strict',
              path: '/',
              maxAge: KNOWN_DEVICE_COOKIE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
            },
          );
        }
        return rest;
      }),
    );
  }
}
