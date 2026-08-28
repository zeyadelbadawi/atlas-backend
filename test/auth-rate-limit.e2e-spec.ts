/**
 * Redis-backed rate limiting e2e — this file's checklist item J. Reads the
 * real configured limits (`.env` / `IdentityConfig`) rather than hardcoding
 * a number, so the test stays correct if the defaults are ever retuned.
 */
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import type { IdentityConfig } from '../src/config/configuration';

describe('Auth rate limiting (e2e)', () => {
  let app: INestApplication;
  let identity: IdentityConfig;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    identity = app.get(ConfigService).getOrThrow<IdentityConfig>('identity');
    flushRateLimitKeys = testApp.flushRateLimitKeys;
  });

  afterAll(async () => {
    await app.close();
  });

  // Every test in this file deliberately runs itself right up to its own
  // limit — without a flush between them, an earlier test's own
  // incidental `/auth/register` call (e.g. the sign-in test's fixture
  // setup) would silently consume one unit of a LATER test's budget on
  // the same IP, since `AuthRateLimiterService` keys are shared across
  // this whole process. Flushing first makes each test's own count
  // exact and independent of file/test order.
  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  it('trips the sign-in rate limit after the configured maximum attempts from one account', async () => {
    const email = uniqueTestEmail('ratelimit-signin');
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Rate Limit Fixture', email, password: 'correct-horse-battery' })
      .expect(201);

    const { max } = identity.signInRateLimit;
    // Deliberately wrong password each time — every attempt still consumes
    // the rate-limit counter regardless of outcome.
    for (let i = 0; i < max; i += 1) {
      await request(app.getHttpServer())
        .post('/auth/sign-in')
        .send({ email, password: 'wrong-password' })
        .expect(401);
    }

    const response = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: 'wrong-password' })
      .expect(429);
    expect(response.body.error.kind).toBe('rateLimited');
  });

  it('trips the registration rate limit after the configured maximum (Phase P18 — this endpoint had no dedicated limit before)', async () => {
    const { max } = identity.registerRateLimit;

    for (let i = 0; i < max; i += 1) {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Rate Limit Fixture',
          email: uniqueTestEmail(`ratelimit-register-${i}`),
          password: 'correct-horse-battery',
        })
        .expect(201);
    }

    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        name: 'Rate Limit Fixture',
        email: uniqueTestEmail('ratelimit-register-over'),
        password: 'correct-horse-battery',
      })
      .expect(429);
    expect(response.body.error.kind).toBe('rateLimited');
  });

  it('trips the password-reset-request rate limit after the configured maximum', async () => {
    const email = uniqueTestEmail('ratelimit-reset');
    const { max } = identity.passwordResetRateLimit;

    for (let i = 0; i < max; i += 1) {
      await request(app.getHttpServer())
        .post('/auth/password-reset/request')
        .send({ email })
        .expect(200);
    }

    const response = await request(app.getHttpServer())
      .post('/auth/password-reset/request')
      .send({ email })
      .expect(429);
    expect(response.body.error.kind).toBe('rateLimited');
  });
});
