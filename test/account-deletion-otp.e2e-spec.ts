/**
 * Authentication audit, Decision 1 — account deletion confirmed by a code
 * emailed to the account's verified address. Real PostgreSQL (RLS as
 * `atlas_app`) and Redis.
 *
 *   DELOTP-01  requesting deletes nothing, emails a purpose-specific code, masks the address
 *   DELOTP-02  a wrong code: 401 with attempts left; the account is intact
 *   DELOTP-03  five wrong codes burn the challenge; the right one no longer works
 *   DELOTP-04  expired, unknown and replayed challenges answer alike
 *   DELOTP-05  another SESSION of the same account cannot use the code
 *   DELOTP-06  another ACCOUNT cannot use a victim's challenge and code
 *   DELOTP-07  a new request retires the older code; resend cooldown 429
 *   DELOTP-08  an unverified address gets no code (409)
 *   DELOTP-09  two concurrent confirmations: exactly one deletes
 *   DELOTP-10  after deletion nothing can still vouch for the person
 *   DELOTP-11  the code is never in the audit trail; RLS hides challenges
 *              from a context-free application connection
 *   DELOTP-12  (W3) the code is not in the subject, is gone from the outbox
 *              once dispatched, and the monitoring events never carry it
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import { PrismaService } from '../src/database/prisma.service';
import { CommunicationsProcessor } from '../src/communications/queue/communications.processor';
import { CommunicationsScheduler } from '../src/communications/queue/communications.scheduler';
import { CommunicationDispatchService } from '../src/communications/services/communication-dispatch.service';
import { StubEmailProvider } from '../src/communications/providers/stub-email.provider';
import type { EmailSendInput } from '../src/identity/services/email-provider.interface';

jest.setTimeout(180000);

class InertCommunicationsProcessor {}
class InertCommunicationsScheduler {}

const PASSWORD = 'correct-horse-battery-delotp';

describe('Account deletion by emailed code (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let appPrisma: PrismaService;
  let flush: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp({
      overrides: (builder) =>
        builder
          .overrideProvider(CommunicationsProcessor)
          .useClass(InertCommunicationsProcessor)
          .overrideProvider(CommunicationsScheduler)
          .useClass(InertCommunicationsScheduler),
    });
    app = testApp.app;
    appPrisma = testApp.prisma;
    flush = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
  });

  const http = () => request(app.getHttpServer());

  async function account(label: string, verified = true) {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    if (verified) {
      await admin.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: new Date() },
      });
    }
    const session = await signIn(email);
    return {
      email,
      userId: user.id,
      token: session.accessToken,
      refresh: session.refreshToken,
    };
  }

  async function signIn(email: string) {
    const res = await http()
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body as { accessToken: string; refreshToken: string };
  }

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function requestCode(token: string) {
    const res = await http()
      .post('/users/me/delete/request')
      .set(bearer(token))
      .expect(200);
    const row = await admin.communicationOutbox.findFirstOrThrow({
      where: { key: 'auth.account.deletion_code', entityId: res.body.challengeId },
    });
    return {
      challengeId: res.body.challengeId as string,
      code: (row.values as { code: string }).code,
      body: res.body as Record<string, string>,
    };
  }

  const confirm = (token: string, challengeId: string, code: string) =>
    http()
      .post('/users/me/delete')
      .set(bearer(token))
      .send({ confirm: true, challengeId, code, reason: 'other' });

  const wrong = (code: string) => (code === '000000' ? '111111' : '000000');

  const status = async (userId: string) =>
    (await admin.user.findUniqueOrThrow({ where: { id: userId } })).status;

  it('DELOTP-01 — requesting deletes nothing, emails a deletion-specific code and masks the address', async () => {
    const a = await account('delotp01');
    const { challengeId, code, body } = await requestCode(a.token);
    expect(code).toMatch(/^\d{6}$/);
    expect(body.maskedEmail).not.toBe(a.email);
    expect(body.maskedEmail).toBe(
      `${a.email[0]}•••${a.email.slice(a.email.indexOf('@'))}`,
    );
    expect(new Date(body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(
      10 * 60 * 1000,
    );
    expect(await status(a.userId)).toBe('active');
    const row = await admin.accountDeletionChallenge.findUniqueOrThrow({
      where: { id: challengeId },
    });
    // Only a keyed hash is stored.
    expect(row.codeHash).not.toContain(code);
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    // Without the code the old one-click request is refused.
    await http()
      .post('/users/me/delete')
      .set(bearer(a.token))
      .send({ confirm: true })
      .expect(400);
  });

  it('DELOTP-02 — a wrong code is refused with attempts left; the account is intact', async () => {
    const a = await account('delotp02');
    const { challengeId, code } = await requestCode(a.token);
    const res = await confirm(a.token, challengeId, wrong(code)).expect(401);
    expect(res.body.error.messageKey).toBe('errors.account.deletionCodeInvalid');
    expect(res.body.error.details.attemptsRemaining).toBe(4);
    expect(await status(a.userId)).toBe('active');
    await confirm(a.token, challengeId, code).expect(200);
    expect(await status(a.userId)).toBe('deleted');
  });

  it('DELOTP-03 — five wrong codes burn the challenge; the right code then fails', async () => {
    const a = await account('delotp03');
    const { challengeId, code } = await requestCode(a.token);
    for (let i = 0; i < 5; i += 1) {
      await flush();
      await confirm(a.token, challengeId, wrong(code)).expect(401);
    }
    await flush();
    const locked = await confirm(a.token, challengeId, code).expect(401);
    expect(locked.body.error.messageKey).toBe(
      'errors.account.deletionCodeAttemptsExceeded',
    );
    await flush();
    const after = await confirm(a.token, challengeId, code).expect(401);
    expect(after.body.error.messageKey).toBe('errors.account.deletionCodeExpired');
    expect(await status(a.userId)).toBe('active');
  });

  it('DELOTP-04 — expired and unknown challenges answer alike', async () => {
    const a = await account('delotp04');
    const { challengeId, code } = await requestCode(a.token);
    await admin.accountDeletionChallenge.update({
      where: { id: challengeId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await confirm(a.token, challengeId, code).expect(401);
    const unknown = await confirm(
      a.token,
      '00000000-0000-4000-8000-000000000000',
      code,
    ).expect(401);
    expect(expired.body.error.messageKey).toBe('errors.account.deletionCodeExpired');
    expect(unknown.body.error.messageKey).toBe(expired.body.error.messageKey);
    expect(await status(a.userId)).toBe('active');
  });

  it('DELOTP-05 — another session of the same account cannot use the code', async () => {
    const a = await account('delotp05');
    const { challengeId, code } = await requestCode(a.token);
    const other = await signIn(a.email);
    await confirm(other.accessToken, challengeId, code).expect(401);
    expect(await status(a.userId)).toBe('active');
    // The session that asked still can.
    await confirm(a.token, challengeId, code).expect(200);
  });

  it("DELOTP-06 — another account cannot spend a victim's challenge and code", async () => {
    const victim = await account('delotp06-victim');
    const attacker = await account('delotp06-attacker');
    const { challengeId, code } = await requestCode(victim.token);
    await confirm(attacker.token, challengeId, code).expect(401);
    expect(await status(victim.userId)).toBe('active');
    expect(await status(attacker.userId)).toBe('active');
  });

  it('DELOTP-07 — a new request retires the older code; within the cooldown it is 429', async () => {
    const a = await account('delotp07');
    const first = await requestCode(a.token);
    const cooldown = await http()
      .post('/users/me/delete/request')
      .set(bearer(a.token))
      .expect(429);
    expect(cooldown.body.error.messageKey).toBe('errors.account.deletionCodeCooldown');
    expect(cooldown.body.error.details.resendAvailableAt).toEqual(expect.any(String));
    await admin.accountDeletionChallenge.update({
      where: { id: first.challengeId },
      data: { createdAt: new Date(Date.now() - 2 * 60 * 1000) },
    });
    const second = await requestCode(a.token);
    await confirm(a.token, first.challengeId, first.code).expect(401);
    await confirm(a.token, second.challengeId, second.code).expect(200);
  });

  it('DELOTP-08 — an unverified address gets no code', async () => {
    const a = await account('delotp08', false);
    const res = await http()
      .post('/users/me/delete/request')
      .set(bearer(a.token))
      .expect(409);
    expect(res.body.error.messageKey).toBe('errors.account.deletionEmailUnverified');
    expect(
      await admin.communicationOutbox.count({
        where: { recipientUserId: a.userId, key: 'auth.account.deletion_code' },
      }),
    ).toBe(0);
  });

  it('DELOTP-09 — two concurrent confirmations with one code: exactly one deletes', async () => {
    const a = await account('delotp09');
    const { challengeId, code } = await requestCode(a.token);
    const results = await Promise.all([
      confirm(a.token, challengeId, code),
      confirm(a.token, challengeId, code),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    const audits = await admin.auditLogEntry.count({
      where: { targetId: a.userId, action: 'account.deleted' },
    });
    expect(audits).toBe(1);
  });

  it('DELOTP-10 — after deletion nothing can still vouch for the person', async () => {
    const a = await account('delotp10');
    await admin.trustedDevice.create({
      data: {
        userId: a.userId,
        surface: 'management',
        label: 'Chrome on macOS',
        tokenHash: `delotp10-${Date.now()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await admin.passwordResetToken.create({
      data: {
        userId: a.userId,
        tokenHash: `delotp10r-${Date.now()}`,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    const { challengeId, code } = await requestCode(a.token);
    await confirm(a.token, challengeId, code).expect(200);

    expect(
      await admin.refreshToken.count({ where: { userId: a.userId, revokedAt: null } }),
    ).toBe(0);
    expect(
      await admin.trustedDevice.count({ where: { userId: a.userId, revokedAt: null } }),
    ).toBe(0);
    expect(await admin.passwordResetToken.count({ where: { userId: a.userId } })).toBe(0);
    expect(
      await admin.accountDeletionChallenge.count({ where: { userId: a.userId } }),
    ).toBe(0);
    expect(
      await admin.authEmailChallenge.count({
        where: { userId: a.userId, consumedAt: null },
      }),
    ).toBe(0);
    await http().get('/users/me').set(bearer(a.token)).expect(401);
    await http().post('/auth/refresh').send({ refreshToken: a.refresh }).expect(401);
    await http()
      .post('/auth/sign-in')
      .send({ email: a.email, password: PASSWORD })
      .expect(401);
  });

  it('DELOTP-11 — the code is never audited; RLS hides challenges from a context-free app connection', async () => {
    const a = await account('delotp11');
    const { challengeId, code } = await requestCode(a.token);
    await confirm(a.token, challengeId, wrong(code)).expect(401);
    const entries = await admin.auditLogEntry.findMany({
      where: { actorUserId: a.userId, action: { startsWith: 'account.deletion.' } },
    });
    expect(entries.map((e) => e.action).sort()).toEqual([
      'account.deletion.code_failed',
      'account.deletion.requested',
    ]);
    expect(JSON.stringify(entries)).not.toContain(code);
    // The runtime role, with no user context, sees none of them.
    expect(
      await appPrisma.accountDeletionChallenge.count({ where: { userId: a.userId } }),
    ).toBe(0);
    expect(
      await admin.accountDeletionChallenge.count({ where: { userId: a.userId } }),
    ).toBe(1);
  });

  it('DELOTP-12 — W3: the code is not in the subject, leaves the outbox on dispatch, and is never in a monitoring event', async () => {
    const a = await account('delotp12');
    const { challengeId, code } = await requestCode(a.token);
    const row = await admin.communicationOutbox.findFirstOrThrow({
      where: { key: 'auth.account.deletion_code', entityId: challengeId },
    });

    const stub = app.get(StubEmailProvider, { strict: false });
    const sent: EmailSendInput[] = [];
    const spy = jest
      .spyOn(stub, 'send')
      .mockImplementation(async (input: EmailSendInput) => {
        sent.push(input);
        return { providerMessageId: `delotp12-${sent.length}`, provider: 'stub' };
      });
    try {
      const dispatcher = app.get(CommunicationDispatchService, { strict: false });
      expect(await dispatcher.dispatch(row.id, { made: 0, max: 6 })).toBe('sent');
    } finally {
      spy.mockRestore();
    }
    const message = sent.find((m) => m.to === a.email);
    expect(message).toBeDefined();
    expect(message!.subject).not.toContain(code);
    expect(message!.text).toContain(code);

    const settled = await admin.communicationOutbox.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(settled.state).toBe('dispatched');
    expect(settled.values).not.toHaveProperty('code');
    expect(JSON.stringify(settled.values)).not.toContain(code);

    await confirm(a.token, challengeId, wrong(code)).expect(401);
    const events = await admin.securityEvent.findMany({
      where: { userId: a.userId },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.eventType)).toEqual([
      'deletion_code_sent',
      'deletion_code_failed',
    ]);
    expect(events[1].reason).toBe('invalid_code');
    expect(events[1].attemptsRemaining).toBe(4);
    expect(JSON.stringify(events)).not.toContain(code);
    expect(JSON.stringify(events)).not.toContain(a.email);
  });
});
