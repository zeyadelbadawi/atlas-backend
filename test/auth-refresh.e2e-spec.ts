/**
 * `POST /auth/refresh` e2e — this file's checklist item D (excluding the
 * dedicated concurrency test, which lives in
 * `auth-refresh-concurrency.e2e-spec.ts`).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueRawTokenFixture, uniqueTestEmail } from './utils/test-app';
import { PrismaService } from '../src/database/prisma.service';
import { hashOpaqueToken } from '../src/identity/utils/opaque-token.util';

async function signUpAndSignIn(
  app: INestApplication,
  email: string,
  password = 'correct-horse-battery',
): Promise<{ accessToken: string; refreshToken: string }> {
  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ name: 'Refresh Fixture', email, password })
    .expect(201);
  const response = await request(app.getHttpServer())
    .post('/auth/sign-in')
    .send({ email, password })
    .expect(200);
  return {
    accessToken: response.body.accessToken,
    refreshToken: response.body.refreshToken,
  };
}

describe('POST /auth/refresh (e2e)', () => {
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

  it('rotates a valid refresh token: old is revoked, new one works, new tokens differ', async () => {
    const email = uniqueTestEmail('refresh-ok');
    const { refreshToken } = await signUpAndSignIn(app, email);

    const response = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(200);

    expect(response.body.refreshToken).not.toBe(refreshToken);
    expect(typeof response.body.accessToken).toBe('string');

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const rows = await prisma.refreshToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(2);
    const original = rows.find((r) => r.tokenHash === hashOpaqueToken(refreshToken));
    expect(original?.revokedAt).not.toBeNull();

    // The old token can never be used again.
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(401);

    // The new token works.
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: response.body.refreshToken })
      .expect(200);
  });

  it('rejects an expired refresh token', async () => {
    const email = uniqueTestEmail('refresh-expired');
    const password = 'correct-horse-battery';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Expired Fixture', email, password })
      .expect(201);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });

    const rawToken = uniqueRawTokenFixture('refresh-expired');
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashOpaqueToken(rawToken),
        expiresAt: new Date(Date.now() - 1000), // already expired
      },
    });

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: rawToken })
      .expect(401);
  });

  it('rejects an already-revoked refresh token', async () => {
    const email = uniqueTestEmail('refresh-revoked');
    const password = 'correct-horse-battery';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Revoked Fixture', email, password })
      .expect(201);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });

    const rawToken = uniqueRawTokenFixture('refresh-revoked');
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashOpaqueToken(rawToken),
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: new Date(),
      },
    });

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: rawToken })
      .expect(401);
  });

  it('rejects an unknown refresh token', async () => {
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: 'this-token-was-never-issued-by-anything' })
      .expect(401);
  });
});
