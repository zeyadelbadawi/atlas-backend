/**
 * The CSRF gate for the two cookie-reading routes (refresh, sign-out).
 */
import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import {
  assertSameOriginCookieRequest,
  sessionCookieName,
  PLAIN_SESSION_COOKIE,
  SECURE_SESSION_COOKIE,
} from './session-cookie';

function req(
  origin: string | undefined,
  hostname = 'academy-a.atlass.dpdns.org',
  protocol = 'https',
): Request {
  return {
    headers: origin === undefined ? {} : { origin },
    hostname,
    protocol,
  } as unknown as Request;
}

describe('assertSameOriginCookieRequest', () => {
  it('accepts the page on this very host', () => {
    expect(() =>
      assertSameOriginCookieRequest(req('https://academy-a.atlass.dpdns.org')),
    ).not.toThrow();
    expect(() =>
      assertSameOriginCookieRequest(req('https://Academy-A.atlass.dpdns.org')),
    ).not.toThrow();
  });

  it.each([
    [
      'another academy on the same platform domain (same-site, cross-origin)',
      'https://academy-b.atlass.dpdns.org',
    ],
    ['the platform host itself', 'https://atlass.dpdns.org'],
    ['a foreign site', 'https://evil.example'],
    ['a look-alike suffix', 'https://academy-a.atlass.dpdns.org.evil.example'],
    [
      'plain HTTP on the same host (scheme downgrade)',
      'http://academy-a.atlass.dpdns.org',
    ],
    ['an opaque origin', 'null'],
    ['a malformed origin', 'https://academy-a.atlass.dpdns.org/path'],
    ['garbage', 'not a url'],
  ])('refuses %s', (_label, origin) => {
    expect(() => assertSameOriginCookieRequest(req(origin))).toThrow(ForbiddenException);
  });

  it('refuses a request with no Origin at all', () => {
    expect(() => assertSameOriginCookieRequest(req(undefined))).toThrow(
      ForbiddenException,
    );
  });

  it('refuses when the request host is unknown', () => {
    expect(() => assertSameOriginCookieRequest(req('https://x.example', ''))).toThrow(
      ForbiddenException,
    );
  });
});

describe('sessionCookieName', () => {
  it('is __Host- prefixed over HTTPS and plain over HTTP', () => {
    expect(sessionCookieName({ secure: true })).toBe(SECURE_SESSION_COOKIE);
    expect(sessionCookieName({ secure: false })).toBe(PLAIN_SESSION_COOKIE);
  });
});
