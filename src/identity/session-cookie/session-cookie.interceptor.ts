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

@Injectable()
export class SessionCookieInterceptor implements NestInterceptor {
  constructor(private readonly configService: ConfigService) {}

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
        return rest;
      }),
    );
  }
}
