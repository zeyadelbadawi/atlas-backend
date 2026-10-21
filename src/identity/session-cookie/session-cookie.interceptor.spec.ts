import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { lastValueFrom, of } from 'rxjs';
import { SessionCookieInterceptor } from './session-cookie.interceptor';
import { SIGNED_IN_HINT_COOKIE } from './signed-in-hint';
import type { SignInThrottleService } from '../services/sign-in-throttle.service';

describe('SessionCookieInterceptor — signed-in hint (DL-63)', () => {
  const config = {
    getOrThrow: jest.fn(() => ({ refreshTokenTtlDays: 30 })),
    get: jest.fn((key: string) =>
      key === 'platformDomain' ? { baseDomain: 'atlass.dpdns.org' } : undefined,
    ),
  } as unknown as ConfigService;
  const throttle = {
    mintKnownDevice: jest.fn(() => 'k'),
  } as unknown as SignInThrottleService;

  async function run(hostname: string, body: unknown) {
    const response = { cookie: jest.fn() };
    const request = { secure: true, hostname };
    const context = {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of(body) };
    const out = await lastValueFrom(
      new SessionCookieInterceptor(config, throttle).intercept(context, next),
    );
    const names = response.cookie.mock.calls.map((call: unknown[]) => call[0]);
    return { out, names };
  }

  it('sets the hint next to the session cookie on the dashboard host, and never returns the refresh token', async () => {
    const { out, names } = await run('dashboard.atlass.dpdns.org', {
      accessToken: 'a',
      refreshToken: 'r',
      expiresIn: 900,
    });
    expect(names).toEqual(['__Host-atlas_session', SIGNED_IN_HINT_COOKIE]);
    expect(out).toEqual({ accessToken: 'a', expiresIn: 900 });
  });

  it('does not set the hint on an academy host', async () => {
    const { names } = await run('nour.atlass.dpdns.org', {
      accessToken: 'a',
      refreshToken: 'r',
    });
    expect(names).toEqual(['__Host-atlas_session']);
  });

  it('sets nothing when no session was minted', async () => {
    const { names } = await run('dashboard.atlass.dpdns.org', { ok: true });
    expect(names).toEqual([]);
  });
});
