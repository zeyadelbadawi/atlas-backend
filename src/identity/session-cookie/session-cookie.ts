/**
 * The browser session cookie (production-readiness pass).
 *
 * THE MODEL. The refresh token — a 30-day credential that mints sessions —
 * never reaches JavaScript. It travels only in this cookie:
 *
 *   `__Host-atlas_session=<opaque>; HttpOnly; Secure; SameSite=Strict; Path=/`
 *
 *   - `HttpOnly`: no script on the page (an XSS, a compromised dependency)
 *     can read it, so it cannot be exfiltrated and replayed elsewhere.
 *   - `__Host-` + no `Domain`: bound to the exact host that issued it. Every
 *     Atlas host — the platform, each academy subdomain, each custom domain —
 *     serves the SPA and `/api` from one origin behind Caddy, so each holds its
 *     own session, exactly like the per-surface/per-academy session binding
 *     the refresh rows already carry.
 *   - `SameSite=Strict`: never sent on a cross-site request or navigation.
 *
 * The access token (15 minutes) is returned in the JSON body and kept in the
 * page's memory only; a reload re-obtains it from this cookie.
 *
 * CSRF. Only two routes read the cookie — `POST /auth/refresh` and
 * `POST /auth/sign-out` — and both require `assertSameOriginCookieRequest`:
 * an `Origin` header naming exactly this request's own scheme and host.
 * `SameSite=Strict` stops cross-SITE requests; the Origin check also stops
 * cross-ORIGIN requests within the site (one academy subdomain's page
 * addressing another's host), which SameSite alone would allow.
 *
 * Plain HTTP (local development, the e2e harness) cannot set a `Secure` or
 * `__Host-` cookie, so there the name is `atlas_session` without `Secure` —
 * the same concession the device cookie makes (`cookies.util.ts`).
 */
import { ForbiddenException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { readCookie } from '../../common/http/cookies.util';

export const SECURE_SESSION_COOKIE = '__Host-atlas_session';
export const PLAIN_SESSION_COOKIE = 'atlas_session';

/** The cookie name for this request's scheme. */
export function sessionCookieName(request: Pick<Request, 'secure'>): string {
  return request.secure ? SECURE_SESSION_COOKIE : PLAIN_SESSION_COOKIE;
}

/** The session cookie this request carries, if any (only the scheme-appropriate name is read). */
export function readSessionCookie(request: Request): string | undefined {
  const value = readCookie(request.headers.cookie, sessionCookieName(request));
  return value && value.length <= 512 ? value : undefined;
}

export function setSessionCookie(
  request: Request,
  response: Response,
  refreshToken: string,
  maxAgeSeconds: number,
): void {
  response.cookie(sessionCookieName(request), refreshToken, {
    httpOnly: true,
    secure: request.secure,
    sameSite: 'strict',
    path: '/',
    maxAge: maxAgeSeconds * 1000,
  });
}

export function clearSessionCookie(request: Request, response: Response): void {
  response.clearCookie(sessionCookieName(request), {
    httpOnly: true,
    secure: request.secure,
    sameSite: 'strict',
    path: '/',
  });
}

/**
 * Refuses a cookie-authenticated request unless the browser says it came from
 * this very origin. Browsers always send `Origin` on a `fetch`/XHR POST, so a
 * legitimate call from the Atlas page on this host always passes.
 */
export function assertSameOriginCookieRequest(request: Request): void {
  const origin = request.headers.origin;
  const host = request.headers.host;
  const expected = host ? `${request.protocol}://${host}` : null;
  if (!origin || !expected || origin.toLowerCase() !== expected.toLowerCase()) {
    throw new ForbiddenException({ messageKey: 'errors.auth.crossOriginSession' });
  }
}
