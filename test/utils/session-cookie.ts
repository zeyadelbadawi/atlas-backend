/**
 * The refresh token of a session-issuing response, read from its
 * `Set-Cookie` header — refresh tokens are never in a response body
 * (production-readiness pass; `SessionCookieInterceptor`). The e2e harness
 * speaks plain HTTP, so the cookie is `atlas_session` (no `__Host-`/Secure).
 */
import type { Response } from 'supertest';

export const SESSION_COOKIE = 'atlas_session';

export function sessionTokenFrom(res: Pick<Response, 'headers'>): string | undefined {
  const raw = res.headers['set-cookie'] as unknown;
  const cookies = Array.isArray(raw)
    ? (raw as string[])
    : typeof raw === 'string'
      ? [raw]
      : [];
  for (const cookie of cookies) {
    const [pair] = cookie.split(';');
    const index = pair.indexOf('=');
    if (index > 0 && pair.slice(0, index).trim() === SESSION_COOKIE) {
      const value = decodeURIComponent(pair.slice(index + 1).trim());
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

/** A `Cookie:` header carrying this session (for cookie-mode refresh/sign-out). */
export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
}
