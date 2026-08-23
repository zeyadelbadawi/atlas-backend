/**
 * Guard/401 behavior + no-secret-logging — this file's checklist item K.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import type { IdentityConfig } from '../src/config/configuration';

describe('Auth guard / security (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /users/me without a token returns 401', async () => {
    await request(app.getHttpServer()).get('/users/me').expect(401);
  });

  it('GET /users/me with a malformed token returns 401', async () => {
    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', 'Bearer not-a-real-jwt')
      .expect(401);
  });

  it('GET /users/me with a token signed by a different secret returns 401', async () => {
    const jwtService = app.get(JwtService, { strict: false });
    const forged = jwtService.sign(
      { sub: 'someone', sid: 'somesession' },
      { secret: 'a-completely-different-secret-not-the-real-one', expiresIn: '15m' },
    );

    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${forged}`)
      .expect(401);
  });

  it('GET /users/me with an expired token returns 401', async () => {
    const jwtService = app.get(JwtService, { strict: false });
    const identity = app.get(ConfigService).getOrThrow<IdentityConfig>('identity');
    const expired = jwtService.sign(
      { sub: 'someone', sid: 'somesession' },
      { secret: identity.jwtAccessSecret, expiresIn: '1s' },
    );

    await new Promise((resolve) => setTimeout(resolve, 1200));

    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${expired}`)
      .expect(401);
  });

  it('GET /auth/validate succeeds with a valid token and fails without one', async () => {
    const email = uniqueTestEmail('validate');
    const password = 'correct-horse-battery';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Validate Fixture', email, password })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(200);

    await request(app.getHttpServer())
      .get('/auth/validate')
      .set('Authorization', `Bearer ${signIn.body.accessToken}`)
      .expect(200);

    await request(app.getHttpServer()).get('/auth/validate').expect(401);
  });

  it('never writes the raw password, access token, or refresh token to structured logs', async () => {
    const email = uniqueTestEmail('no-secret-log');
    const password = 'super-secret-password-marker-XYZ';

    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matching Node's own overloaded `write` signature is not worth the type gymnastics in a test-only spy.
    (process.stdout.write as any) = (chunk: any, ...rest: any[]) => {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return originalWrite(chunk, ...rest);
    };

    let accessToken = '';
    let refreshToken = '';
    try {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ name: 'No Secret Log Fixture', email, password })
        .expect(201);
      const signIn = await request(app.getHttpServer())
        .post('/auth/sign-in')
        .send({ email, password })
        .expect(200);
      accessToken = signIn.body.accessToken;
      refreshToken = signIn.body.refreshToken;

      await request(app.getHttpServer())
        .post('/auth/password-reset/request')
        .send({ email })
        .expect(200);

      await request(app.getHttpServer())
        .post('/users/me/password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: password, newPassword: 'yet-another-secret-marker-ABC' })
        .expect(200);
    } finally {
      process.stdout.write = originalWrite;
    }

    const logged = chunks.join('\n');
    expect(logged).not.toContain(password);
    expect(logged).not.toContain('yet-another-secret-marker-ABC');
    expect(logged).not.toContain(accessToken);
    expect(logged).not.toContain(refreshToken);
  });
});
