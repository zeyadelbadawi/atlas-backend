/**
 * Password reset request/confirm e2e — this file's checklist item F.
 * Rate limiting itself is covered by the dedicated
 * `auth-rate-limit.e2e-spec.ts`, not duplicated here.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  createTestApp,
  uniqueRawTokenFixture,
  uniqueTestEmail,
  waitFor,
} from './utils/test-app';
import { PrismaService } from '../src/database/prisma.service';
import { StubEmailProvider } from '../src/identity/services/stub-email.provider';
import { hashOpaqueToken } from '../src/identity/utils/opaque-token.util';

describe('Password reset (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stubEmailProvider: StubEmailProvider;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    prisma = testApp.prisma;
    stubEmailProvider = testApp.stubEmailProvider;
  });

  afterAll(async () => {
    await app.close();
  });

  it('does not reveal whether an unknown email has an account', async () => {
    const email = uniqueTestEmail('reset-unknown');

    const response = await request(app.getHttpServer())
      .post('/auth/password-reset/request')
      .send({ email })
      .expect(200);

    expect(response.body).toEqual({});
    // No token was ever generated for an account that doesn't exist — give
    // the worker a moment to (not) run, then confirm it really is absent
    // rather than just "not yet processed."
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stubEmailProvider.peekLastPasswordResetToken(email)).toBeUndefined();
  });

  it('full flow: request → confirm → old password stops working, new one works, sessions revoked', async () => {
    // Explicit timeout: `waitFor`'s own 5000ms default polling budget was
    // coincidentally close enough to Jest's default 5000ms per-test
    // timeout that the very first BullMQ job after a fresh app boot (which
    // has one-time worker warm-up latency the rest of the suite doesn't
    // pay) could occasionally lose the race against Jest's own clock, not
    // `waitFor`'s. Headroom, not a slower assertion.
    const email = uniqueTestEmail('reset-flow');
    const oldPassword = 'correct-horse-battery';
    const newPassword = 'donkey-staple-battery-2';

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Reset Flow Fixture', email, password: oldPassword })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: oldPassword })
      .expect(200);

    await request(app.getHttpServer())
      .post('/auth/password-reset/request')
      .send({ email })
      .expect(200);

    const rawToken = await waitFor(() =>
      stubEmailProvider.peekLastPasswordResetToken(email),
    );

    // The raw token is never what's stored.
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const storedToken = await prisma.passwordResetToken.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(storedToken.tokenHash).not.toBe(rawToken);
    expect(storedToken.tokenHash).toBe(hashOpaqueToken(rawToken));

    await request(app.getHttpServer())
      .post('/auth/password-reset/confirm')
      .send({ token: rawToken, newPassword })
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

    // The refresh token from before the reset is dead.
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: signIn.body.refreshToken })
      .expect(401);
  }, 15000);

  it('rejects a reset token twice (single-use)', async () => {
    const email = uniqueTestEmail('reset-single-use');
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Single Use Fixture', email, password: 'correct-horse-battery' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/auth/password-reset/request')
      .send({ email })
      .expect(200);
    const rawToken = await waitFor(() =>
      stubEmailProvider.peekLastPasswordResetToken(email),
    );

    await request(app.getHttpServer())
      .post('/auth/password-reset/confirm')
      .send({ token: rawToken, newPassword: 'brand-new-password-1' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/auth/password-reset/confirm')
      .send({ token: rawToken, newPassword: 'another-new-password-2' })
      .expect(401);
  }, 15000);

  it('rejects an expired reset token', async () => {
    const email = uniqueTestEmail('reset-expired');
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Expired Reset Fixture', email, password: 'correct-horse-battery' })
      .expect(201);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });

    const rawToken = uniqueRawTokenFixture('reset-expired');
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashOpaqueToken(rawToken),
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    await request(app.getHttpServer())
      .post('/auth/password-reset/confirm')
      .send({ token: rawToken, newPassword: 'irrelevant-new-password' })
      .expect(401);
  });

  it('rejects an unknown reset token', async () => {
    await request(app.getHttpServer())
      .post('/auth/password-reset/confirm')
      .send({
        token: uniqueRawTokenFixture('never-issued'),
        newPassword: 'irrelevant-new-password',
      })
      .expect(401);
  });
});
