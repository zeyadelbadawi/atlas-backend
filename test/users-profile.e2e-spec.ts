/**
 * `GET/PATCH /users/me`, `PATCH /users/me/preferences` e2e — this file's
 * checklist items G and H.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';

async function signUp(
  app: INestApplication,
  label: string,
): Promise<{ email: string; accessToken: string }> {
  const email = uniqueTestEmail(label);
  const password = 'correct-horse-battery';
  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ name: 'Profile Fixture', email, password })
    .expect(201);
  const signIn = await request(app.getHttpServer())
    .post('/auth/sign-in')
    .send({ email, password })
    .expect(200);
  return { email, accessToken: signIn.body.accessToken };
}

describe('Users /me (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /users/me returns the correct user with no password_hash field', async () => {
    const { email, accessToken } = await signUp(app, 'me-get');

    const response = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(response.body.email).toBe(email);
    expect(response.body).not.toHaveProperty('passwordHash');
    expect(response.body).not.toHaveProperty('password_hash');
    expect(JSON.stringify(response.body)).not.toContain('argon2');
  });

  it('PATCH /users/me updates only name/avatar and rejects unknown fields', async () => {
    const { accessToken } = await signUp(app, 'me-patch');

    const response = await request(app.getHttpServer())
      .patch('/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Updated Name', avatar: 'https://example.test/avatar.png' })
      .expect(200);

    expect(response.body.name).toBe('Updated Name');
    expect(response.body.avatar).toBe('https://example.test/avatar.png');

    // A field outside the allowed set is rejected by the global
    // `whitelist + forbidNonWhitelisted` ValidationPipe, not silently
    // ignored — matches "PATCH /users/me accepts only {name?, avatar?}."
    await request(app.getHttpServer())
      .patch('/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ email: 'attempted-email-change@atlas.test' })
      .expect(400);
  });

  it('PATCH /users/me/preferences reads and updates only the calling user', async () => {
    const userA = await signUp(app, 'prefs-a');
    const userB = await signUp(app, 'prefs-b');

    const updateA = await request(app.getHttpServer())
      .patch('/users/me/preferences')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ preferences: { theme: 'dark', language: 'en' } })
      .expect(200);
    expect(updateA.body.preferences.theme).toBe('dark');
    expect(updateA.body.preferences.language).toBe('en');

    // User B's preferences are untouched by User A's update.
    const meB = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${userB.accessToken}`)
      .expect(200);
    expect(meB.body.preferences?.theme).not.toBe('dark');

    // A second, partial update merges rather than clobbering the first.
    const updateA2 = await request(app.getHttpServer())
      .patch('/users/me/preferences')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ preferences: { notifications: { email: true, push: false, sms: false } } })
      .expect(200);
    expect(updateA2.body.preferences.theme).toBe('dark'); // still present
    expect(updateA2.body.preferences.notifications).toEqual({
      email: true,
      push: false,
      sms: false,
    });
  });
});
