/**
 * Account-takeover review — regression suite, end to end against the real
 * `AppModule`, Postgres with FORCE RLS, Redis and the communications outbox.
 *
 *   ATO-F1  A grant by somebody else never lands on an account whose mailbox
 *           was never proven: the account returns to `invited`, every
 *           credential and session its registrant held is withdrawn, and the
 *           mailbox gets the setup link. A verified account is untouched.
 *   ATO-RS  A password reset — the first mailbox proof — removes the 2FA and
 *           external sign-ins an unproven account carried; a PROVEN account
 *           keeps its 2FA (a reset is never a way around the second factor).
 *   ATO-F3  Enrolling 2FA needs the password; enabling/disabling notifies;
 *           disabling ends every OTHER session.
 *   ATO-F14 One TOTP code cannot mint two sessions concurrently.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { generate } from 'otplib';

import { createTestApp, uniqueTestEmail, waitFor } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { sessionTokenFrom } from './utils/session-cookie';
import type { StubEmailProvider } from '../src/identity/services/stub-email.provider';

jest.setTimeout(120000);

const PASSWORD = 'correct-horse-battery-ato';

describe('Account-takeover hardening (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let stubEmailProvider: StubEmailProvider;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    // The real communications pipeline: the reset link is read from the
    // stub provider, exactly as the mailbox owner would receive it.
    const testApp = await createTestApp();
    app = testApp.app;
    stubEmailProvider = testApp.stubEmailProvider;
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  interface Session {
    readonly email: string;
    readonly userId: string;
    readonly token: string;
    readonly refreshCookie: string;
  }

  async function signIn(email: string, password = PASSWORD): Promise<Session> {
    const res = await http().post('/auth/sign-in').send({ email, password }).expect(200);
    return {
      email,
      userId: res.body.user.id as string,
      token: res.body.accessToken as string,
      refreshCookie: sessionTokenFrom(res) ?? '',
    };
  }

  /** A management account as `/auth/register` leaves it: active, mailbox NOT proven. */
  async function registered(label: string): Promise<Session> {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    return signIn(email);
  }

  async function verified(label: string): Promise<Session> {
    const session = await registered(label);
    await admin.user.update({
      where: { id: session.userId },
      data: { emailVerifiedAt: new Date() },
    });
    return session;
  }

  async function academyOwnedBy(ownerUserId: string, label: string) {
    const org = await seedOrganizationWithOwner(admin, ownerUserId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await admin.academy.update({ where: { id: academy.id }, data: { status: 'active' } });
    await seedAcademyMember(admin, academy.id, ownerUserId, 'owner');
    return { id: academy.id, orgId: org.id };
  }

  function refresh(cookie: string) {
    return http()
      .post('/auth/refresh')
      .set('Origin', 'http://localhost')
      .set('Cookie', cookie);
  }

  async function enrolTotp(session: Session): Promise<string> {
    const setup = await http()
      .post('/auth/2fa/setup')
      .set(bearer(session.token))
      .expect(200);
    const secret = setup.body.secret as string;
    await http()
      .post('/auth/2fa/confirm')
      .set(bearer(session.token))
      .send({ token: await generate({ secret }), password: PASSWORD })
      .expect(200);
    return secret;
  }

  async function outboxCount(userId: string, key: string): Promise<number> {
    return admin.communicationOutbox.count({ where: { recipientUserId: userId, key } });
  }

  // ------------------------------------------------------------------
  // F1 — pre-account takeover through a later grant
  // ------------------------------------------------------------------

  describe('ATO-F1 — grants to an unproven account', () => {
    it('ATO-F1-01 — an unverified registrant does NOT inherit a Manager grant: the account returns to invited and its session ends', async () => {
      const owner = await verified('f1-owner');
      const academy = await academyOwnedBy(owner.userId, 'f1');
      // The impostor registered the address first and is signed in.
      const impostor = await registered('f1-impostor');
      const secret = await enrolTotp(impostor);
      expect(secret).toBeTruthy();

      const res = await http()
        .post(`/academies/${academy.id}/members`)
        .set(bearer(owner.token))
        .send({ email: impostor.email, name: 'Chief Finance' })
        .expect(201);
      // The API's word for "an existing account that must finish setup".
      expect(res.body.outcome).toBe('reinvited');

      const user = await admin.user.findUniqueOrThrow({ where: { id: impostor.userId } });
      expect(user.status).toBe('invited');
      expect(await admin.userCredential.count({ where: { userId: user.id } })).toBe(0);
      expect(await admin.userTwoFactor.count({ where: { userId: user.id } })).toBe(0);
      expect(await admin.userAuthIdentity.count({ where: { userId: user.id } })).toBe(0);
      // Every session of the impostor ended — refresh and the live access token.
      expect(
        await admin.refreshToken.count({ where: { userId: user.id, revokedAt: null } }),
      ).toBe(0);
      await refresh(impostor.refreshCookie).expect(401);
      await http().get('/users/me').set(bearer(impostor.token)).expect(401);
      // The chosen password no longer signs in.
      await http()
        .post('/auth/sign-in')
        .send({ email: impostor.email, password: PASSWORD })
        .expect(401);
      // The mailbox gets the setup link — not an "added" notice.
      expect(await outboxCount(user.id, 'academy.member.invited')).toBe(1);
      expect(await outboxCount(user.id, 'academy.member.added')).toBe(0);
      // The membership exists, waiting for whoever can read the mailbox.
      expect(
        await admin.academyMember.count({
          where: { academyId: academy.id, userId: user.id },
        }),
      ).toBe(1);
      const audit = await admin.auditLogEntry.findFirst({
        where: { targetId: user.id, action: 'auth.sessions.revoked' },
        orderBy: { occurredAt: 'desc' },
      });
      expect((audit?.context as Record<string, unknown>)?.trigger).toBe(
        'unverified_account_grant',
      );
    });

    it('ATO-F1-02 — the same applies when the grant is a learner seat', async () => {
      const owner = await verified('f1s-owner');
      const academy = await academyOwnedBy(owner.userId, 'f1s');
      const impostor = await registered('f1s-impostor');
      const res = await http()
        .post(`/academies/${academy.id}/students`)
        .set(bearer(owner.token))
        .send({ email: impostor.email, name: 'Some Learner' })
        .expect(201);
      // The API's word for "an existing account that must finish setup".
      expect(res.body.outcome).toBe('reinvited');
      expect(
        (await admin.user.findUniqueOrThrow({ where: { id: impostor.userId } })).status,
      ).toBe('invited');
      await refresh(impostor.refreshCookie).expect(401);
    });

    it('ATO-F1-03 — a VERIFIED account is added as before: password, 2FA and session untouched', async () => {
      const owner = await verified('f1v-owner');
      const academy = await academyOwnedBy(owner.userId, 'f1v');
      const person = await verified('f1v-person');
      await enrolTotp(person);
      const before = await admin.userCredential.findUniqueOrThrow({
        where: { userId: person.userId },
      });

      const res = await http()
        .post(`/academies/${academy.id}/instructors`)
        .set(bearer(owner.token))
        .send({ email: person.email, name: 'Ignored' })
        .expect(201);
      expect(res.body.outcome).toBe('added');

      const user = await admin.user.findUniqueOrThrow({ where: { id: person.userId } });
      expect(user.status).toBe('active');
      expect(
        (await admin.userCredential.findUniqueOrThrow({ where: { userId: user.id } }))
          .passwordHash,
      ).toBe(before.passwordHash);
      expect(await admin.userTwoFactor.count({ where: { userId: user.id } })).toBe(1);
      await http().get('/users/me').set(bearer(person.token)).expect(200);
    });

    it('ATO-F1-04 — a caller who may not grant cannot use the add to sign anyone out', async () => {
      const owner = await verified('f1a-owner');
      const academy = await academyOwnedBy(owner.userId, 'f1a');
      const stranger = await verified('f1a-stranger');
      const victim = await registered('f1a-victim');
      const res = await http()
        .post(`/academies/${academy.id}/members`)
        .set(bearer(stranger.token))
        .send({ email: victim.email, name: 'X' });
      expect([403, 404]).toContain(res.status);
      expect(
        (await admin.user.findUniqueOrThrow({ where: { id: victim.userId } })).status,
      ).toBe('active');
      await http().get('/users/me').set(bearer(victim.token)).expect(200);
    });
  });

  // ------------------------------------------------------------------
  // Reset — the first mailbox proof
  // ------------------------------------------------------------------

  async function resetPassword(email: string, newPassword: string): Promise<void> {
    await http().post('/auth/password-reset/request').send({ email }).expect(200);
    const raw = await waitFor(() => stubEmailProvider.peekLastPasswordResetToken(email));
    await http()
      .post('/auth/password-reset/confirm')
      .send({ token: raw, newPassword })
      .expect(200);
  }

  describe('ATO-RS — password reset and attached sign-in methods', () => {
    it('ATO-RS-01 — on a never-verified account the reset removes the 2FA its registrant enrolled and records the address as verified', async () => {
      const impostor = await registered('rs-unproven');
      await enrolTotp(impostor);
      // …and a Google sign-in bound while the address was unproven.
      await admin.userAuthIdentity.create({
        data: {
          userId: impostor.userId,
          provider: 'google',
          providerSubject: `ato-rs-${impostor.userId}`,
          emailAtLink: impostor.email,
        },
      });
      await resetPassword(impostor.email, 'mailbox-owner-password-1');

      const user = await admin.user.findUniqueOrThrow({ where: { id: impostor.userId } });
      expect(user.emailVerifiedAt).not.toBeNull();
      expect(await admin.userTwoFactor.count({ where: { userId: user.id } })).toBe(0);
      expect(await admin.userAuthIdentity.count({ where: { userId: user.id } })).toBe(0);
      expect(
        await admin.auditLogEntry.count({
          where: { targetId: user.id, action: 'auth.sign_in_methods.removed' },
        }),
      ).toBe(1);
      expect(
        await admin.twoFactorRecoveryCode.count({ where: { userId: user.id } }),
      ).toBe(0);
      // The mailbox owner signs straight in — no impostor authenticator in the way.
      const res = await http()
        .post('/auth/sign-in')
        .send({ email: impostor.email, password: 'mailbox-owner-password-1' })
        .expect(200);
      expect(res.body.accessToken).toEqual(expect.any(String));
    });

    it('ATO-RS-02 — a PROVEN account keeps its 2FA through a reset: sign-in still demands the code', async () => {
      const owner = await verified('rs-proven');
      await enrolTotp(owner);
      await resetPassword(owner.email, 'new-password-proven-1');

      expect(await admin.userTwoFactor.count({ where: { userId: owner.userId } })).toBe(
        1,
      );
      const res = await http()
        .post('/auth/sign-in')
        .send({ email: owner.email, password: 'new-password-proven-1' })
        .expect(200);
      expect(res.body.accessToken).toBeUndefined();
      expect(res.body.twoFactorRequired ?? res.body.challengeId).toBeTruthy();
    });
  });

  // ------------------------------------------------------------------
  // F3 — 2FA enrolment needs re-authentication; changes are announced
  // ------------------------------------------------------------------

  describe('ATO-F3 — two-factor enrolment and removal', () => {
    it('ATO-F3-01 — a session alone cannot enrol 2FA: no password → 400, wrong password → 401, right password → 200 and a notice', async () => {
      const person = await verified('f3-enrol');
      const setup = await http()
        .post('/auth/2fa/setup')
        .set(bearer(person.token))
        .expect(200);
      const secret = setup.body.secret as string;

      await http()
        .post('/auth/2fa/confirm')
        .set(bearer(person.token))
        .send({ token: await generate({ secret }) })
        .expect(400);
      const wrong = await http()
        .post('/auth/2fa/confirm')
        .set(bearer(person.token))
        .send({ token: await generate({ secret }), password: 'not-the-password' })
        .expect(401);
      expect(wrong.body.error.messageKey).toBe('errors.auth.invalidCredentials');
      expect(
        (
          await admin.userTwoFactor.findUniqueOrThrow({
            where: { userId: person.userId },
          })
        ).confirmedAt,
      ).toBeNull();

      await http()
        .post('/auth/2fa/confirm')
        .set(bearer(person.token))
        .send({ token: await generate({ secret }), password: PASSWORD })
        .expect(200);
      expect(await outboxCount(person.userId, 'auth.two_factor.enabled')).toBe(1);
      const feed = await admin.notification.count({
        where: {
          userId: person.userId,
          titleKey: 'notifications:events.twoFactorEnabled.title',
        },
      });
      expect(feed).toBe(1);
    });

    it('ATO-F3-02 — turning 2FA off ends every OTHER session, keeps the current one, and notifies', async () => {
      const person = await verified('f3-disable');
      await enrolTotp(person);
      // A second session — e.g. somebody else's browser — opened earlier.
      await admin.userTwoFactor.deleteMany({ where: { userId: person.userId } });
      const other = await signIn(person.email);
      // Re-enrol on the first session so there is something to turn off.
      await enrolTotp(person);

      await http()
        .post('/auth/2fa/disable')
        .set(bearer(person.token))
        .send({ password: PASSWORD })
        .expect(204);

      await http().get('/users/me').set(bearer(person.token)).expect(200);
      await http().get('/users/me').set(bearer(other.token)).expect(401);
      await refresh(other.refreshCookie).expect(401);
      expect(await outboxCount(person.userId, 'auth.two_factor.disabled')).toBe(1);
    });
  });

  // ------------------------------------------------------------------
  // F14 — a TOTP code is single-use even under concurrency
  // ------------------------------------------------------------------

  describe('ATO-F14 — TOTP replay', () => {
    it('ATO-F14-01 — the same code submitted to two challenges at once mints at most one session', async () => {
      const person = await verified('f14');
      const secret = await enrolTotp(person);
      // Move past the step enrolment consumed.
      const nextStep = Math.floor(Date.now() / 1000 / 30) + 1;
      const code = await generate({ secret, epoch: nextStep * 30 });

      const challenge = async (): Promise<string> => {
        const res = await http()
          .post('/auth/sign-in')
          .send({ email: person.email, password: PASSWORD })
          .expect(200);
        return res.body.challengeId as string;
      };
      const [a, b] = [await challenge(), await challenge()];
      const results = await Promise.all(
        [a, b].map((challengeId) =>
          http().post('/auth/2fa/verify').send({ challengeId, token: code }),
        ),
      );
      const ok = results.filter((r) => r.status === 200);
      expect(ok.length).toBeLessThanOrEqual(1);
    });
  });
});
