/**
 * ATO review F7 — nobody can lock an account owner out of their own account
 * by sending wrong passwords from elsewhere, while guessing stays bounded.
 *
 *   SLR-01  an attacker's network exhausting an address's budget does not
 *           stop the owner signing in from their own network
 *   SLR-02  the per-account budget covers the attacker's whole /24, not one
 *           host
 *   SLR-03  past the account-wide failure ceiling (distributed guessing),
 *           an unknown browser is refused even with the right password, and
 *           a browser that signed in to the account before still gets in
 *   SLR-04  a known-device cookie minted for another account does not help
 *   SLR-05  failures for an address with no account count the same way
 *           (the ceiling is no existence oracle)
 *   SLR-06  the per-IP flood limit still caps one address trying many
 *           accounts
 *
 * Client networks are simulated with `X-Real-IP`, which the app trusts only
 * from a private/loopback peer (Caddy in production, supertest here).
 */
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';

import { createTestApp, uniqueTestEmail } from './utils/test-app';
import type { IdentityConfig } from '../src/config/configuration';
import { PLAIN_KNOWN_DEVICE_COOKIE } from '../src/identity/services/sign-in-throttle.service';

jest.setTimeout(180000);

const PASSWORD = 'correct-horse-battery-slr';
/** Above the per-network budget (10), so each limit is exercised on its own. */
const CEILING = 15;

describe('Lockout-resistant sign-in throttling (e2e) — ATO F7', () => {
  let app: INestApplication;
  let limits: IdentityConfig['signInRateLimit'];
  let flushRateLimitKeys: () => Promise<void>;
  const saved = process.env.AUTH_SIGNIN_ACCOUNT_FAILURE_CEILING;

  beforeAll(async () => {
    process.env.AUTH_SIGNIN_ACCOUNT_FAILURE_CEILING = String(CEILING);
    const testApp = await createTestApp();
    app = testApp.app;
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    limits = app
      .get(ConfigService)
      .getOrThrow<IdentityConfig>('identity').signInRateLimit;
    expect(limits.accountFailureCeiling).toBe(CEILING);
    expect(limits.max).toBeLessThan(CEILING);
  });

  afterAll(async () => {
    await app.close();
    if (saved === undefined) delete process.env.AUTH_SIGNIN_ACCOUNT_FAILURE_CEILING;
    else process.env.AUTH_SIGNIN_ACCOUNT_FAILURE_CEILING = saved;
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  const http = () => request(app.getHttpServer());

  async function register(label: string): Promise<string> {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .send({ name: 'SLR Tester', email, password: PASSWORD })
      .expect(201);
    await flushRateLimitKeys();
    return email;
  }

  function signIn(email: string, ip: string, password = PASSWORD, cookie?: string) {
    const call = http()
      .post('/auth/sign-in')
      .set('X-Real-IP', ip)
      .send({ email, password });
    return cookie ? call.set('Cookie', cookie) : call;
  }

  function knownDeviceCookie(response: request.Response): string {
    const setCookie = (response.headers['set-cookie'] as unknown as string[]) ?? [];
    const raw = setCookie.find((value) =>
      value.startsWith(`${PLAIN_KNOWN_DEVICE_COOKIE}=`),
    );
    if (!raw) throw new Error('No known-device cookie was set.');
    return raw.split(';')[0];
  }

  it('SLR-01 — an attacker exhausting the budget elsewhere does not lock the owner out', async () => {
    const email = await register('slr-01');
    for (let i = 0; i < limits.max; i += 1) {
      await signIn(email, '203.0.113.10', 'wrong-password').expect(401);
    }
    await signIn(email, '203.0.113.10', 'wrong-password').expect(429);
    // The owner, on their own network, signs straight in.
    await signIn(email, '198.51.100.7').expect(200);
  });

  it("SLR-02 — the per-account budget covers the attacker's whole /24", async () => {
    const email = await register('slr-02');
    for (let i = 0; i < limits.max; i += 1) {
      await signIn(email, `203.0.113.${20 + i}`, 'wrong-password').expect(401);
    }
    await signIn(email, '203.0.113.99', 'wrong-password').expect(429);
    await signIn(email, '198.51.100.8').expect(200);
  });

  it('SLR-03 — past the account-wide ceiling only a known browser gets in', async () => {
    const email = await register('slr-03');
    // The owner signs in once from their usual browser.
    const first = await signIn(email, '198.51.100.9').expect(200);
    const cookie = knownDeviceCookie(first);

    // Distributed guessing: one failure from each of many networks.
    for (let i = 0; i < CEILING; i += 1) {
      await signIn(email, `${20 + i}.0.2.1`, 'wrong-password').expect(401);
    }

    // An unknown browser, on a fresh network, with the RIGHT password.
    const refused = await signIn(email, '198.51.100.200').expect(429);
    expect(refused.body.error.messageKey).toBe('errors.auth.rateLimited');

    // The owner's known browser still signs in.
    await signIn(email, '198.51.100.201', PASSWORD, cookie).expect(200);
  });

  it('SLR-04 — a known-device cookie for another account does not help', async () => {
    const other = await register('slr-04-other');
    const otherCookie = knownDeviceCookie(
      await signIn(other, '198.51.100.30').expect(200),
    );
    const email = await register('slr-04');
    for (let i = 0; i < CEILING; i += 1) {
      await signIn(email, `${20 + i}.1.2.3`, 'wrong-password').expect(401);
    }
    await signIn(email, '198.51.100.31', PASSWORD, otherCookie).expect(429);
    // A forged cookie fails the same way.
    await signIn(
      email,
      '198.51.100.32',
      PASSWORD,
      `${PLAIN_KNOWN_DEVICE_COOKIE}=v1.abc.def`,
    ).expect(429);
  });

  it('SLR-05 — an address with no account reaches the ceiling the same way', async () => {
    const email = uniqueTestEmail('slr-05-nobody');
    for (let i = 0; i < CEILING; i += 1) {
      await signIn(email, `${20 + i}.3.4.5`, 'wrong-password').expect(401);
    }
    const refused = await signIn(email, '198.51.100.40', 'wrong-password').expect(429);
    expect(refused.body.error.messageKey).toBe('errors.auth.rateLimited');
  });

  it('SLR-06 — the per-IP flood limit caps one address trying many accounts', async () => {
    for (let i = 0; i < limits.ipMax; i += 1) {
      await signIn(
        uniqueTestEmail(`slr-06-${i}`),
        '203.0.113.60',
        'wrong-password',
      ).expect(401);
    }
    await signIn(uniqueTestEmail('slr-06-over'), '203.0.113.60', 'wrong-password').expect(
      429,
    );
  });
});
