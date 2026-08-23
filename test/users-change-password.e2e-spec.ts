/**
 * `POST /users/me/password` e2e — this file's checklist item I.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';

describe('POST /users/me/password (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
  });

  afterAll(async () => {
    await app.close();
  });

  it('changes the password and revokes existing sessions, keeping the current access token usable', async () => {
    const email = uniqueTestEmail('changepw');
    const oldPassword = 'correct-horse-battery';
    const newPassword = 'staple-battery-donkey-2';

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Change Password Fixture', email, password: oldPassword })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: oldPassword })
      .expect(200);

    await request(app.getHttpServer())
      .post('/users/me/password')
      .set('Authorization', `Bearer ${signIn.body.accessToken}`)
      .send({ currentPassword: oldPassword, newPassword })
      .expect(200);

    // Old password no longer works.
    await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: oldPassword })
      .expect(401);

    // New password works.
    await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: newPassword })
      .expect(200);

    // The refresh token from the pre-change session is revoked...
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: signIn.body.refreshToken })
      .expect(401);

    // ...but the still-short-lived access token used to *make* the change
    // keeps working until its own natural expiry — matches "issue no
    // automatic new session," not "invalidate the current request."
    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${signIn.body.accessToken}`)
      .expect(200);
  });

  it('rejects an incorrect current password and leaves the password unchanged', async () => {
    const email = uniqueTestEmail('changepw-wrong');
    const password = 'correct-horse-battery';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Wrong Current Fixture', email, password })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(200);

    await request(app.getHttpServer())
      .post('/users/me/password')
      .set('Authorization', `Bearer ${signIn.body.accessToken}`)
      .send({ currentPassword: 'not-the-real-password', newPassword: 'irrelevant-new-1' })
      .expect(401);

    // The original password still works.
    await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(200);
  });

  it('rejects the request without a valid access token', async () => {
    await request(app.getHttpServer())
      .post('/users/me/password')
      .send({ currentPassword: 'irrelevant', newPassword: 'irrelevant-new-1' })
      .expect(401);
  });
});
