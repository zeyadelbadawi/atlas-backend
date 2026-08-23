/**
 * `POST /auth/sign-out` e2e — this file's checklist item E: sign-out
 * revokes the current session only, another device's session survives.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';

describe('POST /auth/sign-out (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
  });

  afterAll(async () => {
    await app.close();
  });

  it('revokes only the calling session, not a second concurrent session', async () => {
    const email = uniqueTestEmail('signout');
    const password = 'correct-horse-battery';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Sign Out Fixture', email, password })
      .expect(201);

    // Two independent "devices" signing in to the same account.
    const deviceA = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(200);
    const deviceB = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(200);

    await request(app.getHttpServer())
      .post('/auth/sign-out')
      .set('Authorization', `Bearer ${deviceA.body.accessToken}`)
      .expect(200);

    // Device A's refresh token is now dead.
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: deviceA.body.refreshToken })
      .expect(401);

    // Device B's session is completely unaffected.
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: deviceB.body.refreshToken })
      .expect(200);
  });

  it('is idempotent — signing out twice never errors', async () => {
    const email = uniqueTestEmail('signout-twice');
    const password = 'correct-horse-battery';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Sign Out Twice Fixture', email, password })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(200);

    await request(app.getHttpServer())
      .post('/auth/sign-out')
      .set('Authorization', `Bearer ${signIn.body.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/auth/sign-out')
      .set('Authorization', `Bearer ${signIn.body.accessToken}`)
      .expect(200);
  });

  it('rejects sign-out without an access token', async () => {
    await request(app.getHttpServer()).post('/auth/sign-out').expect(401);
  });
});
