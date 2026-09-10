/**
 * Phase 10.3 — TOTP two-factor authentication (P103-2FA-001..020).
 *
 * Phase 10 shipped only a documented insertion point and explicitly
 * deferred the feature. This suite exercises the real implementation
 * through the HTTP surface, generating genuine TOTP codes with the same
 * library an authenticator app uses.
 *
 * THE LOAD-BEARING TESTS are the ones about what a challenge is NOT:
 * P103-2FA-006 proves a correct password alone issues no session, and
 * P103-2FA-007 proves the challenge id cannot be used as a bearer token.
 * A 2FA implementation that got those wrong would look completely
 * functional in a browser while providing no security at all.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { generate } from 'otplib';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

const PASSWORD = 'correct-horse-battery';

describe('Phase 10.3 two-factor authentication (e2e) — P103-2FA-001..020', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  async function signUp(email: string): Promise<{ token: string; userId: string }> {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: '2FA Tester', email, password: PASSWORD })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return { token: signIn.body.accessToken, userId: signIn.body.user.id };
  }

  /** Enrols a user fully and returns everything needed to sign in again. */
  async function enrol(email: string) {
    const { token, userId } = await signUp(email);

    const setup = await request(app.getHttpServer())
      .post('/auth/2fa/setup')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const secret: string = setup.body.secret;
    const code = await generate({ secret });

    const confirmed = await request(app.getHttpServer())
      .post('/auth/2fa/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ token: code })
      .expect(200);

    return {
      token,
      userId,
      email,
      secret,
      recoveryCodes: confirmed.body.recoveryCodes as string[],
    };
  }

  function signIn(email: string) {
    return request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD });
  }

  /**
   * A code guaranteed to differ from `usedCode`, for replay tests — the
   * current step's code is deliberately reused, so this just perturbs it.
   */
  function differentCode(code: string): string {
    const next = (Number(code) + 1) % 1_000_000;
    return String(next).padStart(6, '0');
  }

  /**
   * A valid code for the NEXT 30-second time step.
   *
   * Necessary — not a convenience — because the replay guard records the
   * time step of every accepted code and refuses anything at or before
   * it. Enrolment consumes the current step, so a code generated
   * immediately afterwards is the SAME code and is correctly rejected as
   * a replay. Stepping forward one period is what a real authenticator
   * app does thirty seconds later, and `epochTolerance: 1` accepts it.
   *
   * This is also the cheapest honest way to test the guard without
   * sleeping 30 seconds in every test.
   */
  function nextStepCode(secret: string): Promise<string> {
    return generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 });
  }

  // ---------------- setup ----------------

  it('P103-2FA-001 — a new account starts with 2FA disabled', async () => {
    const { token } = await signUp(uniqueTestEmail('p103-001'));
    const status = await request(app.getHttpServer())
      .get('/auth/2fa/status')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(status.body).toEqual({
      enabled: false,
      pendingSetup: false,
      recoveryCodesRemaining: 0,
    });
  });

  it('P103-2FA-002 — setup returns a secret and a scannable QR, and stores the secret ENCRYPTED', async () => {
    const email = uniqueTestEmail('p103-002');
    const { token, userId } = await signUp(email);

    const setup = await request(app.getHttpServer())
      .post('/auth/2fa/setup')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(setup.body.secret).toMatch(/^[A-Z2-7]+$/);
    expect(setup.body.qrCodeDataUri).toMatch(/^data:image\/png;base64,/);

    const record = await admin.userTwoFactor.findUniqueOrThrow({ where: { userId } });
    // The stored value must NOT be the secret.
    expect(record.encryptedSecret).not.toBe(setup.body.secret);
    expect(record.encryptedSecret).not.toContain(setup.body.secret);
    // Still unconfirmed — enrolment is not enforcement.
    expect(record.confirmedAt).toBeNull();
  });

  it('P103-2FA-003 — an unconfirmed setup does NOT enforce 2FA at sign-in', async () => {
    // A mis-scanned QR must never lock someone out of their own account.
    const email = uniqueTestEmail('p103-003');
    const { token } = await signUp(email);
    await request(app.getHttpServer())
      .post('/auth/2fa/setup')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const response = await signIn(email).expect(200);
    expect(response.body.accessToken).toBeTruthy();
    expect(response.body.twoFactorRequired).toBeFalsy();
  });

  it('P103-2FA-004 — an invalid setup code is refused and 2FA stays off', async () => {
    const email = uniqueTestEmail('p103-004');
    const { token, userId } = await signUp(email);
    await request(app.getHttpServer())
      .post('/auth/2fa/setup')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/auth/2fa/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ token: '000000' })
      .expect(400);

    const record = await admin.userTwoFactor.findUniqueOrThrow({ where: { userId } });
    expect(record.confirmedAt).toBeNull();
  });

  it('P103-2FA-005 — a valid setup code enables 2FA and issues recovery codes', async () => {
    const enrolled = await enrol(uniqueTestEmail('p103-005'));

    expect(enrolled.recoveryCodes).toHaveLength(10);
    enrolled.recoveryCodes.forEach((code) => expect(code).toMatch(/^[a-f0-9]{10}$/));

    const status = await request(app.getHttpServer())
      .get('/auth/2fa/status')
      .set('Authorization', `Bearer ${enrolled.token}`)
      .expect(200);
    expect(status.body.enabled).toBe(true);
    expect(status.body.recoveryCodesRemaining).toBe(10);

    // Stored hashed, never in the clear.
    const stored = await admin.twoFactorRecoveryCode.findMany({
      where: { userId: enrolled.userId },
    });
    expect(stored).toHaveLength(10);
    enrolled.recoveryCodes.forEach((plain) => {
      expect(stored.some((row) => row.codeHash === plain)).toBe(false);
    });
  });

  // ---------------- sign-in challenge ----------------

  it('P103-2FA-006 — with 2FA on, a CORRECT PASSWORD alone issues no session', async () => {
    // The load-bearing test. If this regressed, 2FA would appear to work
    // in a browser while providing no protection whatsoever.
    const enrolled = await enrol(uniqueTestEmail('p103-006'));

    const response = await signIn(enrolled.email).expect(200);

    expect(response.body.twoFactorRequired).toBe(true);
    expect(response.body.challengeId).toBeTruthy();
    expect(response.body.accessToken).toBeUndefined();
    expect(response.body.refreshToken).toBeUndefined();
    expect(response.body.user).toBeUndefined();

    // No session row was created either.
    const sessions = await admin.refreshToken.count({
      where: { userId: enrolled.userId, revokedAt: null },
    });
    // Only the one from the initial enrolment sign-in.
    expect(sessions).toBe(1);
  });

  it('P103-2FA-007 — the challenge id is NOT usable as an access token', async () => {
    const enrolled = await enrol(uniqueTestEmail('p103-007'));
    const challenge = await signIn(enrolled.email).expect(200);

    for (const path of ['/auth/sessions', '/auth/2fa/status', '/users/me']) {
      await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${challenge.body.challengeId}`)
        .expect(401);
    }
  });

  it('P103-2FA-008 — a valid TOTP code completes sign-in and issues a real session', async () => {
    const enrolled = await enrol(uniqueTestEmail('p103-008'));
    const challenge = await signIn(enrolled.email).expect(200);

    const code = await nextStepCode(enrolled.secret);
    const verified = await request(app.getHttpServer())
      .post('/auth/2fa/verify')
      .send({ challengeId: challenge.body.challengeId, token: code })
      .expect(200);

    expect(verified.body.accessToken).toBeTruthy();
    expect(verified.body.refreshToken).toBeTruthy();
    expect(verified.body.user.id).toBe(enrolled.userId);

    // And the issued token really works.
    await request(app.getHttpServer())
      .get('/auth/sessions')
      .set('Authorization', `Bearer ${verified.body.accessToken}`)
      .expect(200);
  });

  it('P103-2FA-009 — an invalid TOTP code is refused', async () => {
    const enrolled = await enrol(uniqueTestEmail('p103-009'));
    const challenge = await signIn(enrolled.email).expect(200);

    await request(app.getHttpServer())
      .post('/auth/2fa/verify')
      .send({ challengeId: challenge.body.challengeId, token: '000000' })
      .expect(401);
  });

  it('P103-2FA-010 — REPLAYING an already-used code is refused', async () => {
    // A code stays mathematically valid for its whole 30-second window,
    // so an attacker who observes one has a real opportunity. The stored
    // time step is what closes it.
    const enrolled = await enrol(uniqueTestEmail('p103-010'));

    const first = await signIn(enrolled.email).expect(200);
    const code = await nextStepCode(enrolled.secret);
    await request(app.getHttpServer())
      .post('/auth/2fa/verify')
      .send({ challengeId: first.body.challengeId, token: code })
      .expect(200);

    // Same code, brand-new challenge, well within the code's validity.
    const second = await signIn(enrolled.email).expect(200);
    await request(app.getHttpServer())
      .post('/auth/2fa/verify')
      .send({ challengeId: second.body.challengeId, token: code })
      .expect(401);
  });

  it('P103-2FA-011 — an unknown or expired challenge is refused', async () => {
    const enrolled = await enrol(uniqueTestEmail('p103-011'));
    const code = await nextStepCode(enrolled.secret);

    await request(app.getHttpServer())
      .post('/auth/2fa/verify')
      .send({ challengeId: 'a'.repeat(43), token: code })
      .expect(401);
  });

  it('P103-2FA-012 — a challenge is single-use', async () => {
    const enrolled = await enrol(uniqueTestEmail('p103-012'));
    const challenge = await signIn(enrolled.email).expect(200);

    const code = await nextStepCode(enrolled.secret);
    await request(app.getHttpServer())
      .post('/auth/2fa/verify')
      .send({ challengeId: challenge.body.challengeId, token: code })
      .expect(200);

    // Reusing the same challenge, even with a fresh code, must fail.
    await request(app.getHttpServer())
      .post('/auth/2fa/verify')
      .send({ challengeId: challenge.body.challengeId, token: differentCode(code) })
      .expect(401);
  });

  it('P103-2FA-013 — brute force against one challenge is bounded', async () => {
    const enrolled = await enrol(uniqueTestEmail('p103-013'));
    const challenge = await signIn(enrolled.email).expect(200);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await request(app.getHttpServer())
        .post('/auth/2fa/verify')
        .send({ challengeId: challenge.body.challengeId, token: '123456' })
        .expect(401);
    }

    // The challenge is burned: even the CORRECT code no longer works.
    const code = await nextStepCode(enrolled.secret);
    await request(app.getHttpServer())
      .post('/auth/2fa/verify')
      .send({ challengeId: challenge.body.challengeId, token: code })
      .expect(401);
  });

  // ---------------- recovery codes ----------------

  it('P103-2FA-014 — a recovery code completes sign-in', async () => {
    const enrolled = await enrol(uniqueTestEmail('p103-014'));
    const challenge = await signIn(enrolled.email).expect(200);

    const verified = await request(app.getHttpServer())
      .post('/auth/2fa/verify')
      .send({
        challengeId: challenge.body.challengeId,
        recoveryCode: enrolled.recoveryCodes[0],
      })
      .expect(200);

    expect(verified.body.accessToken).toBeTruthy();
  });

  it('P103-2FA-015 — a recovery code is SINGLE USE', async () => {
    const enrolled = await enrol(uniqueTestEmail('p103-015'));
    const code = enrolled.recoveryCodes[0];

    const first = await signIn(enrolled.email).expect(200);
    await request(app.getHttpServer())
      .post('/auth/2fa/verify')
      .send({ challengeId: first.body.challengeId, recoveryCode: code })
      .expect(200);

    const second = await signIn(enrolled.email).expect(200);
    await request(app.getHttpServer())
      .post('/auth/2fa/verify')
      .send({ challengeId: second.body.challengeId, recoveryCode: code })
      .expect(401);

    const status = await request(app.getHttpServer())
      .get('/auth/2fa/status')
      .set('Authorization', `Bearer ${enrolled.token}`)
      .expect(200);
    expect(status.body.recoveryCodesRemaining).toBe(9);
  });

  it("P103-2FA-016 — one user's recovery code does not work for another", async () => {
    const alice = await enrol(uniqueTestEmail('p103-016-a'));
    const bob = await enrol(uniqueTestEmail('p103-016-b'));

    const challenge = await signIn(bob.email).expect(200);
    await request(app.getHttpServer())
      .post('/auth/2fa/verify')
      .send({
        challengeId: challenge.body.challengeId,
        recoveryCode: alice.recoveryCodes[0],
      })
      .expect(401);
  });

  it('P103-2FA-017 — regenerating recovery codes invalidates the old set and requires the password', async () => {
    const enrolled = await enrol(uniqueTestEmail('p103-017'));
    const oldCode = enrolled.recoveryCodes[0];

    // A session alone is not enough.
    await request(app.getHttpServer())
      .post('/auth/2fa/recovery-codes')
      .set('Authorization', `Bearer ${enrolled.token}`)
      .send({ password: 'not-the-password' })
      .expect(401);

    const regenerated = await request(app.getHttpServer())
      .post('/auth/2fa/recovery-codes')
      .set('Authorization', `Bearer ${enrolled.token}`)
      .send({ password: PASSWORD })
      .expect(200);

    expect(regenerated.body.recoveryCodes).toHaveLength(10);
    expect(regenerated.body.recoveryCodes).not.toContain(oldCode);

    // The old code is dead.
    const challenge = await signIn(enrolled.email).expect(200);
    await request(app.getHttpServer())
      .post('/auth/2fa/verify')
      .send({ challengeId: challenge.body.challengeId, recoveryCode: oldCode })
      .expect(401);
  });

  // ---------------- management and isolation ----------------

  it('P103-2FA-018 — disabling 2FA REQUIRES the password, not just a session', async () => {
    // If a session were sufficient, stealing one would be enough to strip
    // the control that exists to make a stolen session useless.
    const enrolled = await enrol(uniqueTestEmail('p103-018'));

    await request(app.getHttpServer())
      .post('/auth/2fa/disable')
      .set('Authorization', `Bearer ${enrolled.token}`)
      .send({ password: 'not-the-password' })
      .expect(401);

    // Still enforced.
    const stillChallenged = await signIn(enrolled.email).expect(200);
    expect(stillChallenged.body.twoFactorRequired).toBe(true);

    await request(app.getHttpServer())
      .post('/auth/2fa/disable')
      .set('Authorization', `Bearer ${enrolled.token}`)
      .send({ password: PASSWORD })
      .expect(204);

    // Now a plain sign-in works again, and the codes are gone.
    const plain = await signIn(enrolled.email).expect(200);
    expect(plain.body.accessToken).toBeTruthy();
    expect(
      await admin.twoFactorRecoveryCode.count({ where: { userId: enrolled.userId } }),
    ).toBe(0);
  });

  it('P103-2FA-019 — 2FA endpoints reject unauthenticated and cross-user access', async () => {
    const enrolled = await enrol(uniqueTestEmail('p103-019-a'));
    const other = await signUp(uniqueTestEmail('p103-019-b'));

    // Unauthenticated.
    await request(app.getHttpServer()).get('/auth/2fa/status').expect(401);
    await request(app.getHttpServer()).post('/auth/2fa/setup').expect(401);

    // Another user's token reads only THEIR OWN status — there is no user
    // id parameter anywhere in this controller to point elsewhere.
    const status = await request(app.getHttpServer())
      .get('/auth/2fa/status')
      .set('Authorization', `Bearer ${other.token}`)
      .expect(200);
    expect(status.body.enabled).toBe(false);
    expect(enrolled.userId).not.toBe(other.userId);
  });

  it('P103-2FA-020 — no secret or recovery-code material leaks in status or errors', async () => {
    const enrolled = await enrol(uniqueTestEmail('p103-020'));

    const status = await request(app.getHttpServer())
      .get('/auth/2fa/status')
      .set('Authorization', `Bearer ${enrolled.token}`)
      .expect(200);

    const serialised = JSON.stringify(status.body);
    expect(serialised).not.toContain(enrolled.secret);
    enrolled.recoveryCodes.forEach((code) => {
      expect(serialised).not.toContain(code);
    });
    expect(serialised).not.toContain('encryptedSecret');

    // A failed verification echoes nothing back either.
    const challenge = await signIn(enrolled.email).expect(200);
    const failed = await request(app.getHttpServer())
      .post('/auth/2fa/verify')
      .send({ challengeId: challenge.body.challengeId, token: '000000' })
      .expect(401);
    expect(JSON.stringify(failed.body)).not.toContain(enrolled.secret);
  });
});
