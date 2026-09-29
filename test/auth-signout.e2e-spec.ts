/**
 * `POST /auth/sign-out` e2e — this file's checklist item E: sign-out
 * revokes the current session only, another device's session survives.
 */
import { sessionTokenFrom } from './utils/session-cookie';
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
      .send({ refreshToken: sessionTokenFrom(deviceA) })
      .expect(401);

    // Device B's session is completely unaffected.
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: sessionTokenFrom(deviceB) })
      .expect(200);
  });

  it('signing out twice is safe: the second is a no-op, the session stays dead', async () => {
    // Production-readiness pass — sign-out is idempotent. It identifies the
    // session by a VALID access token or by the HttpOnly session cookie; a
    // revoked access token is neither, so the second call authenticates
    // nothing and ends nothing — it only clears this browser's cookie. The
    // property that matters is unchanged and asserted below: the session the
    // first call ended stays dead everywhere.
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

    // Signing out again is a harmless no-op.
    await request(app.getHttpServer())
      .post('/auth/sign-out')
      .set('Authorization', `Bearer ${signIn.body.accessToken}`)
      .expect(200);
    // Its refresh token is dead too.
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: sessionTokenFrom(signIn) })
      .expect(401);

    // And it stays dead: no partial revocation, no route that still
    // accepts it.
    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${signIn.body.accessToken}`)
      .expect(401);
  });

  it('sign-out without any session is a no-op that only clears the cookie', async () => {
    const res = await request(app.getHttpServer()).post('/auth/sign-out').expect(200);
    const cleared = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    expect(cleared.some((c) => /^atlas_session=;/.test(c))).toBe(true);
  });
});
