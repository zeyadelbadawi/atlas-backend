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

  it('signing out twice is safe: the second attempt is refused, never a partial state', async () => {
    // REWRITTEN FOR PHASE 10. This previously asserted a second sign-out
    // returns 200. That was true before `JwtAuthGuard` started checking
    // the session-revocation denylist; now the first sign-out genuinely
    // kills the session, so presenting the same access token again is an
    // authentication failure — which is the WHOLE POINT of revocation and
    // must not be relaxed back to 200 to make a test green.
    //
    // The property that actually matters is preserved and still asserted:
    // a repeated sign-out never errors in a way that leaves the session
    // half-revoked. It is refused cleanly, and the session stays dead.
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

    // The session is genuinely gone, so the same token no longer
    // authenticates anything — sign-out included.
    await request(app.getHttpServer())
      .post('/auth/sign-out')
      .set('Authorization', `Bearer ${signIn.body.accessToken}`)
      .expect(401);

    // And it stays dead: no partial revocation, no route that still
    // accepts it.
    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${signIn.body.accessToken}`)
      .expect(401);
  });

  it('rejects sign-out without an access token', async () => {
    await request(app.getHttpServer()).post('/auth/sign-out').expect(401);
  });
});
