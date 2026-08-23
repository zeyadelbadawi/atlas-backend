/**
 * `POST /auth/sign-in` e2e — this file's checklist item C.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { PrismaService } from '../src/database/prisma.service';

async function registerUser(
  app: INestApplication,
  email: string,
  password: string,
): Promise<void> {
  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ name: 'Sign In Fixture', email, password })
    .expect(201);
}

describe('POST /auth/sign-in (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    prisma = testApp.prisma;
  });

  afterAll(async () => {
    await app.close();
  });

  it('signs in with valid credentials and issues both tokens', async () => {
    const email = uniqueTestEmail('signin-ok');
    const password = 'correct-horse-battery';
    await registerUser(app, email, password);

    const response = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(200);

    expect(typeof response.body.accessToken).toBe('string');
    expect(typeof response.body.refreshToken).toBe('string');
    expect(typeof response.body.expiresIn).toBe('number');
    expect(response.body.user.email).toBe(email);
    expect(response.body.user).not.toHaveProperty('passwordHash');
    expect(response.body.user).not.toHaveProperty('password_hash');
    expect(response.body.user.roles).toEqual([]);
    expect(response.body.user.organizations).toEqual([]);

    // The raw refresh token is never what's stored.
    const dbUser = await prisma.user.findUniqueOrThrow({ where: { email } });
    const storedTokens = await prisma.refreshToken.findMany({
      where: { userId: dbUser.id },
    });
    expect(storedTokens).toHaveLength(1);
    expect(storedTokens[0].tokenHash).not.toBe(response.body.refreshToken);
  });

  it('rejects an unknown email with a generic invalid-credentials error', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: uniqueTestEmail('signin-unknown'), password: 'whatever-password' })
      .expect(401);

    expect(response.body.error.messageKey).toBe('errors.auth.invalidCredentials');
  });

  it('rejects a wrong password with the same generic error', async () => {
    const email = uniqueTestEmail('signin-wrongpw');
    await registerUser(app, email, 'correct-horse-battery');

    const response = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: 'totally-wrong-password' })
      .expect(401);

    expect(response.body.error.messageKey).toBe('errors.auth.invalidCredentials');
  });

  it('rejects a suspended account', async () => {
    const email = uniqueTestEmail('signin-suspended');
    const password = 'correct-horse-battery';
    await registerUser(app, email, password);
    await prisma.user.update({ where: { email }, data: { status: 'suspended' } });

    const response = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(403);

    expect(response.body.error.messageKey).toBe('errors.auth.accountSuspended');
  });

  it('updates lastSignInAt on successful sign-in', async () => {
    const email = uniqueTestEmail('signin-lastseen');
    const password = 'correct-horse-battery';
    await registerUser(app, email, password);

    const before = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(before.lastSignInAt).toBeNull();

    await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(200);

    const after = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(after.lastSignInAt).not.toBeNull();
  });
});
