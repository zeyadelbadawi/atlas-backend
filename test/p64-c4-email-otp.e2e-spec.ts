/**
 * P64 Communications C4 — the emailed sign-in code and trusted devices,
 * end to end against the real `AppModule`, real Postgres with FORCE RLS,
 * real Redis and the real communications outbox.
 *
 * WHAT THESE ARE FOR. Almost every property this feature claims is
 * enforced by a SQL statement or by an HTTP-level rule, so a mocked
 * transaction would prove nothing about any of them. The load-bearing
 * ones, in the order an attacker would try them:
 *
 *  - P64-C4-002 — a correct password alone issues NO session. If this
 *    ever stopped holding, everything below would still pass while the
 *    feature provided no security at all.
 *  - P64-C4-003 — the challenge reference is not a bearer token.
 *  - P64-C4-004 — the raw code is never in the database.
 *  - P64-C4-01x — wrong / expired / reused / exhausted, each with the
 *    specific answer the deployed frontend is built around.
 *  - P64-C4-02x — a reference forged to pair one account's challenge with
 *    another account's id opens nothing.
 *  - P64-C4-03x — trust is per browser, per account and per surface, is
 *    revocable, and a revoked or foreign cookie skips nothing.
 *
 * The rollout flag is set to `new_device` for this spec's app BEFORE it is
 * constructed, because config is read once at boot. `off` and `always` are
 * covered in `src/identity/services/email-otp.service.spec.ts`, where the
 * policy decision is a pure function and does not need a second app.
 *
 * THE CODE IS READ FROM THE OUTBOX ROW, not from a log or a back door:
 * `CommunicationService.emit` is the only way an email leaves Atlas, and
 * the row it writes is where the code genuinely lives until the
 * dispatcher renders it. P64-C4-041 then dispatches one for real and
 * asserts the stub provider received an email carrying that same code.
 *
 * The `communications` BullMQ processor and scheduler are replaced with
 * inert classes for the same reason `p64-comm-outbox.e2e-spec.ts` does it:
 * otherwise the background worker claims these rows mid-assertion and the
 * spec tests a race rather than a rule.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';

import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import { hashOpaqueToken } from '../src/identity/utils/opaque-token.util';
import { CommunicationsProcessor } from '../src/communications/queue/communications.processor';
import { CommunicationsScheduler } from '../src/communications/queue/communications.scheduler';
import { CommunicationDispatchService } from '../src/communications/services/communication-dispatch.service';
import { AuthChallengeCipher } from '../src/identity/services/auth-challenge-cipher.service';
import {
  TRUST_COOKIE_NAME,
  TrustedDeviceService,
} from '../src/identity/services/trusted-device.service';
import { StubEmailProvider } from '../src/communications/providers/stub-email.provider';
import type { EmailSendInput } from '../src/identity/services/email-provider.interface';

jest.setTimeout(60000);

class InertCommunicationsProcessor {}
class InertCommunicationsScheduler {}

const PASSWORD = 'correct-horse-battery-otp';
const DISPATCH_ATTEMPT = { made: 0, max: 6 } as const;

interface ChallengeBody {
  emailOtpRequired: true;
  challengeId: string;
  expiresAt: string;
  resendAvailableAt: string;
  resendsRemaining: number;
  maskedEmail: string;
}

describe('P64 C4 — email OTP and trusted devices (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let cipher: AuthChallengeCipher;
  let trustedDevices: TrustedDeviceService;
  let dispatcher: CommunicationDispatchService;
  let stubEmailProvider: StubEmailProvider;
  let sent: EmailSendInput[];
  let sendSpy: jest.SpyInstance;
  let previousFlag: string | undefined;

  beforeAll(async () => {
    /*
     * The rollout flag is read ONCE, when `ConfigModule`'s factory runs
     * inside `createTestApp()` — so it has to be in the environment
     * before that call and nowhere earlier.
     *
     * It is restored in `afterAll` because jest reuses one worker
     * PROCESS across spec files (`maxWorkers: 1`): a leaked
     * `FLAG_AUTH_EMAIL_OTP_MODE_MANAGEMENT` would silently make every
     * later spec's sign-in demand a code, and those specs would fail
     * for a reason that has nothing to do with what they test.
     */
    previousFlag = process.env.FLAG_AUTH_EMAIL_OTP_MODE_MANAGEMENT;
    process.env.FLAG_AUTH_EMAIL_OTP_MODE_MANAGEMENT = 'new_device';

    const testApp = await createTestApp({
      overrides: (builder) =>
        builder
          .overrideProvider(CommunicationsProcessor)
          .useClass(InertCommunicationsProcessor)
          .overrideProvider(CommunicationsScheduler)
          .useClass(InertCommunicationsScheduler),
    });
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    stubEmailProvider = testApp.stubEmailProvider;
    cipher = app.get(AuthChallengeCipher, { strict: false });
    trustedDevices = app.get(TrustedDeviceService, { strict: false });
    dispatcher = app.get(CommunicationDispatchService, { strict: false });

    sent = [];
    sendSpy = jest
      .spyOn(stubEmailProvider, 'send')
      .mockImplementation(async (input: EmailSendInput) => {
        sent.push(input);
        return { providerMessageId: `spy-${sent.length}`, provider: 'stub' };
      });
  });

  afterAll(async () => {
    sendSpy.mockRestore();
    await admin.$disconnect();
    await app.close();
    if (previousFlag === undefined) {
      delete process.env.FLAG_AUTH_EMAIL_OTP_MODE_MANAGEMENT;
    } else {
      process.env.FLAG_AUTH_EMAIL_OTP_MODE_MANAGEMENT = previousFlag;
    }
  });

  beforeEach(async () => {
    sent.length = 0;
    await flushRateLimitKeys();
  });

  // --- fixtures ---------------------------------------------------------

  const http = () => request(app.getHttpServer());

  /**
   * The normalised error envelope `AllExceptionsFilter` writes — every
   * refusal in this suite is asserted through it, because
   * `{ error: { messageKey, details } }` is exactly the shape the
   * deployed frontend's `ApiError` reads.
   */
  function err(response: request.Response): {
    messageKey: string;
    details: Record<string, number>;
  } {
    return response.body.error;
  }

  async function register(
    label: string,
    email = uniqueTestEmail(label),
  ): Promise<{ email: string; userId: string }> {
    await http()
      .post('/auth/register')
      .send({ name: 'OTP Tester', email, password: PASSWORD })
      .expect(201);
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    return { email, userId: user.id };
  }

  /** A sign-in from a browser that optionally presents a trust cookie. */
  function signIn(email: string, trustCookie?: string) {
    const req = http().post('/auth/sign-in').send({ email, password: PASSWORD });
    return trustCookie ? req.set('Cookie', `${TRUST_COOKIE_NAME}=${trustCookie}`) : req;
  }

  async function challenge(email: string, trustCookie?: string): Promise<ChallengeBody> {
    const response = await signIn(email, trustCookie).expect(200);
    expect(response.body.emailOtpRequired).toBe(true);
    return response.body as ChallengeBody;
  }

  /** The code exactly as the outbox holds it for the most recent challenge. */
  async function latestCode(userId: string): Promise<string> {
    const rows = await admin.$queryRaw<{ values: { code?: string } | null }[]>`
      SELECT "values" FROM "communication_outbox"
      WHERE "recipient_user_id" = ${userId} AND "key" = 'auth.email.otp'
      ORDER BY "created_at" DESC LIMIT 1
    `;
    const code = rows[0]?.values?.code;
    if (typeof code !== 'string') throw new Error('No OTP outbox row for that user.');
    return code;
  }

  /** The newest challenge row for an account, read with the admin connection. */
  function latestChallengeRow(userId: string) {
    return admin.authEmailChallenge.findFirstOrThrow({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  function verify(
    challengeId: string,
    code: string,
    rememberDevice = false,
    trustCookie?: string,
  ) {
    const req = http()
      .post('/auth/otp/verify')
      .send({ challengeId, code, rememberDevice, surface: 'management' });
    return trustCookie ? req.set('Cookie', `${TRUST_COOKIE_NAME}=${trustCookie}`) : req;
  }

  /** Pulls the `atlas_trust` value out of a `Set-Cookie` header. */
  function readTrustCookie(response: request.Response): string {
    const header = response.headers['set-cookie'] as unknown as string[] | undefined;
    const raw = (header ?? []).find((value) => value.startsWith(`${TRUST_COOKIE_NAME}=`));
    if (!raw) throw new Error('No atlas_trust cookie was set.');
    return decodeURIComponent(raw.split(';')[0].slice(TRUST_COOKIE_NAME.length + 1));
  }

  /** Signs in and completes the code step; returns the session plus the raw response. */
  async function signInWithCode(
    email: string,
    userId: string,
    rememberDevice = false,
  ): Promise<request.Response> {
    const open = await challenge(email);
    const code = await latestCode(userId);
    return verify(open.challengeId, code, rememberDevice).expect(200);
  }

  // ---------------- the challenge itself ----------------

  it('P64-C4-001 — a sign-in on an unrecognised browser answers a challenge in the shape the frontend reads', async () => {
    const { email } = await register('c4-001');
    const body = await challenge(email);

    expect(body.challengeId).toEqual(expect.any(String));
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(body.resendAvailableAt)).toBeGreaterThan(Date.now() - 1000);
    // §12: at most three codes per challenge — the first plus two resends.
    expect(body.resendsRemaining).toBe(2);
    // One character, then a mask, then the real domain.
    expect(body.maskedEmail).toMatch(/^.•••@atlas\.test$/);
  });

  it('P64-C4-002 — a correct password alone issues NO session', async () => {
    const { email } = await register('c4-002');
    const response = await signIn(email).expect(200);

    expect(response.body.accessToken).toBeUndefined();
    expect(response.body.refreshToken).toBeUndefined();
    expect(response.body.user).toBeUndefined();
    // And no session family was opened behind the scenes.
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    expect(await admin.refreshToken.count({ where: { userId: user.id } })).toBe(0);
  });

  it('P64-C4-003 — the challenge reference is not a bearer token', async () => {
    const { email } = await register('c4-003');
    const body = await challenge(email);

    await http()
      .get('/users/me')
      .set('Authorization', `Bearer ${body.challengeId}`)
      .expect(401);
    await http()
      .get('/auth/validate')
      .set('Authorization', `Bearer ${body.challengeId}`)
      .expect(401);
  });

  it('P64-C4-004 — the raw code is never stored; only a salted HMAC is', async () => {
    const { email, userId } = await register('c4-004');
    await challenge(email);
    const code = await latestCode(userId);
    const row = await latestChallengeRow(userId);

    expect(code).toMatch(/^\d{6}$/);
    expect(row.codeHash).not.toContain(code);
    expect(row.codeHash).toHaveLength(64);
    expect(row.salt.length).toBeGreaterThan(0);
    expect(row.attempts).toBe(0);
    expect(row.consumedAt).toBeNull();
  });

  it('P64-C4-005 — the outbox row carries no organisation, so tenant staff can never read a live code', async () => {
    const { email, userId } = await register('c4-005');
    await challenge(email);
    const rows = await admin.$queryRaw<{ organization_id: string | null }[]>`
      SELECT "organization_id" FROM "communication_outbox"
      WHERE "recipient_user_id" = ${userId} AND "key" = 'auth.email.otp'
      ORDER BY "created_at" DESC LIMIT 1
    `;
    expect(rows[0].organization_id).toBeNull();
  });

  // ---------------- success ----------------

  it('P64-C4-010 — the right code mints a real, usable session', async () => {
    const { email, userId } = await register('c4-010');
    const response = await signInWithCode(email, userId);

    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.refreshToken).toEqual(expect.any(String));
    expect(response.body.user.id).toBe(userId);

    await http()
      .get('/auth/validate')
      .set('Authorization', `Bearer ${response.body.accessToken}`)
      .expect(200);
  });

  it('P64-C4-011 — success consumes the challenge and records the proof of email ownership', async () => {
    const { email, userId } = await register('c4-011');
    const before = await admin.user.findUniqueOrThrow({ where: { id: userId } });
    expect(before.emailVerifiedAt).toBeNull();

    await signInWithCode(email, userId);

    const row = await latestChallengeRow(userId);
    expect(row.consumedAt).not.toBeNull();
    const after = await admin.user.findUniqueOrThrow({ where: { id: userId } });
    // §12: reading the code out of the inbox IS the ownership proof.
    expect(after.emailVerifiedAt).not.toBeNull();
  });

  // ---------------- the four failures ----------------

  it('P64-C4-012 — a wrong code is refused and says how many tries are left', async () => {
    const { email, userId } = await register('c4-012');
    const open = await challenge(email);
    const code = await latestCode(userId);
    const wrong = code === '000000' ? '111111' : '000000';

    const first = await verify(open.challengeId, wrong).expect(401);
    expect(err(first).messageKey).toBe('errors.auth.otpInvalid');
    expect(err(first).details.attemptsRemaining).toBe(4);

    const second = await verify(open.challengeId, wrong).expect(401);
    expect(err(second).details.attemptsRemaining).toBe(3);

    // The real code still works afterwards — a wrong guess must not
    // silently poison a challenge the user can still complete.
    await verify(open.challengeId, code).expect(200);
  });

  it('P64-C4-013 — an expired code is refused as expired, not as wrong', async () => {
    const { email, userId } = await register('c4-013');
    const open = await challenge(email);
    const code = await latestCode(userId);
    const row = await latestChallengeRow(userId);

    await admin.authEmailChallenge.update({
      where: { id: row.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await verify(open.challengeId, code).expect(401);
    expect(err(response).messageKey).toBe('errors.auth.otpExpired');
  });

  it('P64-C4-014 — a code cannot be used twice', async () => {
    const { email, userId } = await register('c4-014');
    const open = await challenge(email);
    const code = await latestCode(userId);

    await verify(open.challengeId, code).expect(200);
    const replay = await verify(open.challengeId, code).expect(401);
    expect(err(replay).messageKey).toBe('errors.auth.otpAttemptsExceeded');
  });

  it('P64-C4-015 — five wrong codes destroy the challenge, and the right one no longer works', async () => {
    const { email, userId } = await register('c4-015');
    const open = await challenge(email);
    const code = await latestCode(userId);
    const wrong = code === '000000' ? '111111' : '000000';

    const remaining: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await verify(open.challengeId, wrong).expect(401);
      expect(err(response).messageKey).toBe('errors.auth.otpInvalid');
      remaining.push(err(response).details.attemptsRemaining);
    }
    expect(remaining).toEqual([4, 3, 2, 1]);

    const fifth = await verify(open.challengeId, wrong).expect(401);
    expect(err(fifth).messageKey).toBe('errors.auth.otpAttemptsExceeded');

    // DESTROYED, not merely refused: the correct code is now worthless.
    const withRealCode = await verify(open.challengeId, code).expect(401);
    expect(err(withRealCode).messageKey).toBe('errors.auth.otpAttemptsExceeded');
    expect((await latestChallengeRow(userId)).consumedAt).not.toBeNull();
  });

  it('P64-C4-016 — two simultaneous correct submissions yield exactly one session', async () => {
    const { email, userId } = await register('c4-016');
    const open = await challenge(email);
    const code = await latestCode(userId);

    const [a, b] = await Promise.all([
      verify(open.challengeId, code),
      verify(open.challengeId, code),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);

    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    expect(winner.body.accessToken).toEqual(expect.any(String));
    expect(loser.body.accessToken).toBeUndefined();
  });

  // ---------------- resend ----------------

  it('P64-C4-020 — a resend inside the cooldown is refused, and outside it sends a NEW code', async () => {
    const { email, userId } = await register('c4-020');
    const open = await challenge(email);
    const firstCode = await latestCode(userId);

    const tooSoon = await http()
      .post('/auth/otp/resend')
      .send({ challengeId: open.challengeId })
      .expect(429);
    expect(err(tooSoon).messageKey).toBe('errors.auth.otpResendCooldown');

    // Rewinding the expiry rewinds the derived "last sent at" by the same
    // amount — the cooldown has one source of truth, not two.
    await rewindLastSend(userId, 120);

    const resent = await http()
      .post('/auth/otp/resend')
      .send({ challengeId: open.challengeId })
      .expect(200);
    expect(resent.body.resendsRemaining).toBe(1);
    expect(Date.parse(resent.body.resendAvailableAt)).toBeGreaterThan(Date.now());

    const secondCode = await latestCode(userId);
    expect(secondCode).not.toBe(firstCode);

    // §12: "a new code invalidates the previous".
    const stale = await verify(open.challengeId, firstCode).expect(401);
    expect(err(stale).messageKey).toBe('errors.auth.otpInvalid');
    await verify(open.challengeId, secondCode).expect(200);
  });

  it('P64-C4-021 — a challenge yields at most three codes in total', async () => {
    const { email, userId } = await register('c4-021');
    const open = await challenge(email);

    await rewindLastSend(userId, 120);
    expect(
      (
        await http()
          .post('/auth/otp/resend')
          .send({ challengeId: open.challengeId })
          .expect(200)
      ).body.resendsRemaining,
    ).toBe(1);

    await rewindLastSend(userId, 120);
    expect(
      (
        await http()
          .post('/auth/otp/resend')
          .send({ challengeId: open.challengeId })
          .expect(200)
      ).body.resendsRemaining,
    ).toBe(0);

    await rewindLastSend(userId, 120);
    const exhausted = await http()
      .post('/auth/otp/resend')
      .send({ challengeId: open.challengeId })
      .expect(429);
    expect(err(exhausted).messageKey).toBe('errors.auth.otpResendExhausted');
  });

  it('P64-C4-022 — a resend against a destroyed challenge is refused', async () => {
    const { email, userId } = await register('c4-022');
    const open = await challenge(email);
    const code = await latestCode(userId);
    await verify(open.challengeId, code).expect(200);

    const response = await http()
      .post('/auth/otp/resend')
      .send({ challengeId: open.challengeId })
      .expect(401);
    expect(err(response).messageKey).toBe('errors.auth.otpAttemptsExceeded');
  });

  // ---------------- cross-account and forgery ----------------

  it('P64-C4-030 — one account’s code is refused against another account’s challenge', async () => {
    const a = await register('c4-030a');
    const b = await register('c4-030b');
    await challenge(a.email);
    const codeA = await latestCode(a.userId);

    const openB = await challenge(b.email);
    const codeB = await latestCode(b.userId);
    // Guards against the two codes coinciding by chance (1 in 10^6).
    if (codeA === codeB) return;

    const response = await verify(openB.challengeId, codeA).expect(401);
    expect(err(response).messageKey).toBe('errors.auth.otpInvalid');
  });

  it('P64-C4-070 — concurrent sign-ins on different mail providers: each code email goes to its own address, only its own code opens it', async () => {
    // Provider-agnostic by construction: one address on a big consumer
    // host, one on a small corporate domain (the Hostinger-style case that
    // was investigated in production). No branch anywhere keys on either.
    const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    const a = await register('c4-070a', `p1-c4-070a-${stamp}@gmail.com`);
    const b = await register('c4-070b', `p1.c4-070b-${stamp}@corp-mail.atlas.test`);

    const [openA, openB] = await Promise.all([challenge(a.email), challenge(b.email)]);
    const [codeA, codeB] = await Promise.all([
      latestCode(a.userId),
      latestCode(b.userId),
    ]);

    const outbox = await admin.communicationOutbox.findMany({
      where: { recipientUserId: { in: [a.userId, b.userId] }, key: 'auth.email.otp' },
    });
    expect(outbox).toHaveLength(2);
    await Promise.all(outbox.map((row) => dispatcher.dispatch(row.id, DISPATCH_ATTEMPT)));

    const otpMail = sent.filter((item) =>
      (item.tags ?? []).includes('key:auth.email.otp'),
    );
    const toA = otpMail.filter((item) => item.to === a.email);
    const toB = otpMail.filter((item) => item.to === b.email);
    // Exactly one code email per account, each to that account's own
    // address, and no code email to any other address.
    expect(toA).toHaveLength(1);
    expect(toB).toHaveLength(1);
    expect(
      otpMail.filter((item) => item.to !== a.email && item.to !== b.email),
    ).toHaveLength(0);
    if (codeA !== codeB) {
      expect(toA[0].text).toContain(codeA);
      expect(toA[0].text).not.toContain(codeB);
      expect(toB[0].text).toContain(codeB);
      expect(toB[0].text).not.toContain(codeA);
    }
    // The send input has no sender field at all: the sender is added by
    // the provider adapter from configuration and can never become `to`.
    for (const message of [...toA, ...toB]) {
      expect(Object.keys(message)).not.toContain('from');
      expect(Object.keys(message)).not.toContain('fromEmail');
    }

    // Each code opens only its own account.
    if (codeA !== codeB) {
      await verify(openA.challengeId, codeB).expect(401);
      await verify(openB.challengeId, codeA).expect(401);
    }
    const sessionA = await verify(openA.challengeId, codeA).expect(200);
    const sessionB = await verify(openB.challengeId, codeB).expect(200);
    expect(sessionA.body.user.id).toBe(a.userId);
    expect(sessionB.body.user.id).toBe(b.userId);
  });

  // ------- one proof of mailbox control, not two (first-login contract) -------

  /** Every catalogue key queued for this account, oldest first. */
  async function outboxKeys(userId: string): Promise<string[]> {
    const rows = await admin.communicationOutbox.findMany({
      where: { recipientUserId: userId },
      orderBy: { createdAt: 'asc' },
      select: { key: true },
    });
    return rows.map((row) => row.key);
  }

  it('P64-C4-080 — with the code required, sign-up sends NO verification link; the first OTP sign-in verifies the address', async () => {
    const { email, userId } = await register('c4-080');

    // Registration under `new_device`: no link token, no verification
    // email queued, the address not yet verified.
    expect(await admin.emailVerificationToken.count({ where: { userId } })).toBe(0);
    expect(await outboxKeys(userId)).not.toContain('auth.email.verification');
    expect(
      (await admin.user.findUniqueOrThrow({ where: { id: userId } })).emailVerifiedAt,
    ).toBeNull();

    const session = await signInWithCode(email, userId);
    expect(session.body.user.id).toBe(userId);

    // The code proved the mailbox: verified, and still no link anywhere.
    expect(
      (await admin.user.findUniqueOrThrow({ where: { id: userId } })).emailVerifiedAt,
    ).toBeInstanceOf(Date);
    const keys = await outboxKeys(userId);
    expect(keys).toContain('auth.email.otp');
    expect(keys).not.toContain('auth.email.verification');
    expect(await admin.emailVerificationToken.count({ where: { userId } })).toBe(0);
  });

  it('P64-C4-081 — a wrong or an expired code verifies nothing and opens no session', async () => {
    const { email, userId } = await register('c4-081');
    const open = await challenge(email);
    const code = await latestCode(userId);
    const wrong = code === '000000' ? '111111' : '000000';

    await verify(open.challengeId, wrong).expect(401);
    expect(
      (await admin.user.findUniqueOrThrow({ where: { id: userId } })).emailVerifiedAt,
    ).toBeNull();

    const row = await latestChallengeRow(userId);
    await admin.authEmailChallenge.update({
      where: { id: row.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await verify(open.challengeId, code).expect(401);
    expect(err(expired).messageKey).toBe('errors.auth.otpExpired');
    expect(expired.body.accessToken).toBeUndefined();
    expect(
      (await admin.user.findUniqueOrThrow({ where: { id: userId } })).emailVerifiedAt,
    ).toBeNull();
  });

  it('P64-C4-082 — an existing unverified account holding an old link is verified by its OTP sign-in; the old link stays harmless', async () => {
    const { email, userId } = await register('c4-082');
    // An account created before this change: it still holds a live link.
    const legacyToken = `legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await admin.emailVerificationToken.create({
      data: {
        userId,
        tokenHash: hashOpaqueToken(legacyToken),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    await signInWithCode(email, userId);
    const verifiedAt = (await admin.user.findUniqueOrThrow({ where: { id: userId } }))
      .emailVerifiedAt;
    expect(verifiedAt).toBeInstanceOf(Date);

    // The legacy link is still single-use and only ever re-confirms the
    // same address; it cannot verify anything else.
    await http().post('/auth/verify-email').send({ token: legacyToken }).expect(200);
    const replay = await http().post('/auth/verify-email').send({ token: legacyToken });
    expect(replay.status).toBe(400);
  });

  it('P64-C4-083 — the independent verification path still works: resend issues a link, the link verifies once', async () => {
    const { email, userId } = await register('c4-083');
    const session = await signInWithCode(email, userId);
    // Force the account back to unverified to exercise the link path.
    await admin.user.update({ where: { id: userId }, data: { emailVerifiedAt: null } });

    await http()
      .post('/auth/verify-email/resend')
      .set('Authorization', `Bearer ${session.body.accessToken}`)
      .expect(202);

    const row = await admin.communicationOutbox.findFirstOrThrow({
      where: { recipientUserId: userId, key: 'auth.email.verification' },
      orderBy: { createdAt: 'desc' },
      select: { values: true },
    });
    const token = (row.values as { token?: string } | null)?.token;
    expect(token).toEqual(expect.any(String));

    await http().post('/auth/verify-email').send({ token }).expect(200);
    expect(
      (await admin.user.findUniqueOrThrow({ where: { id: userId } })).emailVerifiedAt,
    ).toBeInstanceOf(Date);
    const replay = await http().post('/auth/verify-email').send({ token });
    expect(replay.status).toBe(400);
  });

  it('P64-C4-031 — a reference forged to pair one account’s challenge with another’s id opens nothing', async () => {
    const a = await register('c4-031a');
    const b = await register('c4-031b');
    await challenge(a.email);
    const codeA = await latestCode(a.userId);
    const rowA = await latestChallengeRow(a.userId);

    // Exactly the attack the sealed reference exists to stop: A's real
    // challenge row, B's user id, A's real code. Sealed with the server's
    // own key, so the seal itself is valid — only the PAIRING is a lie,
    // and the `WHERE user_id = ...` in every statement is what refuses it.
    const forged = cipher.sealChallengeRef({
      challengeRowId: rowA.id,
      userId: b.userId,
    });

    const response = await verify(forged, codeA).expect(401);
    expect(err(response).messageKey).toBe('errors.auth.otpAttemptsExceeded');
    // A's challenge is untouched — a forged attempt must not burn the
    // victim's own attempt budget.
    expect((await latestChallengeRow(a.userId)).attempts).toBe(0);
  });

  it('P64-C4-032 — a tampered or invented reference is refused before any lookup', async () => {
    const { email, userId } = await register('c4-032');
    const open = await challenge(email);
    const code = await latestCode(userId);

    const raw = Buffer.from(open.challengeId, 'base64url');
    raw[raw.length - 1] ^= 0xff;
    const tampered = raw.toString('base64url');

    expect(err(await verify(tampered, code).expect(401)).messageKey).toBe(
      'errors.auth.otpAttemptsExceeded',
    );
    expect(err(await verify('A'.repeat(120), code).expect(401)).messageKey).toBe(
      'errors.auth.otpAttemptsExceeded',
    );

    // The real challenge is still intact and unspent.
    expect((await latestChallengeRow(userId)).attempts).toBe(0);
    await verify(open.challengeId, code).expect(200);
  });

  it('P64-C4-033 — a malformed body is a 400, so junk can never spend an attempt', async () => {
    const { email, userId } = await register('c4-033');
    const open = await challenge(email);

    await http()
      .post('/auth/otp/verify')
      .send({ challengeId: open.challengeId, code: '12345', rememberDevice: false })
      .expect(400);
    await http()
      .post('/auth/otp/verify')
      .send({ challengeId: open.challengeId, code: 'abcdef', rememberDevice: false })
      .expect(400);

    expect((await latestChallengeRow(userId)).attempts).toBe(0);
  });

  // ---------------- trusted devices ----------------

  it('P64-C4-040 — remembering a browser lets it skip the code, and forgetting it brings the code back', async () => {
    const { email, userId } = await register('c4-040');
    const verified = await signInWithCode(email, userId, true);
    const cookie = readTrustCookie(verified);

    // The same browser signs straight in.
    const trusted = await signIn(email, cookie).expect(200);
    expect(trusted.body.accessToken).toEqual(expect.any(String));
    expect(trusted.body.emailOtpRequired).toBeUndefined();

    // A browser with no cookie is still challenged.
    await challenge(email);

    // Forget it, and the trusted browser is challenged again.
    const list = await http()
      .get('/auth/trusted-devices')
      .set('Authorization', `Bearer ${trusted.body.accessToken}`)
      .expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].current).toBe(false); // the API call carried no cookie
    expect(list.body.items[0].surface).toBe('management');

    await http()
      .delete(`/auth/trusted-devices/${list.body.items[0].id}`)
      .set('Authorization', `Bearer ${trusted.body.accessToken}`)
      .expect(204);

    await challenge(email, cookie);
  });

  it('P64-C4-041 — `current` marks the browser that is actually asking', async () => {
    const { email, userId } = await register('c4-041');
    const verified = await signInWithCode(email, userId, true);
    const cookie = readTrustCookie(verified);

    const list = await http()
      .get('/auth/trusted-devices')
      .set('Authorization', `Bearer ${verified.body.accessToken}`)
      .set('Cookie', `${TRUST_COOKIE_NAME}=${cookie}`)
      .expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].current).toBe(true);
    // No token material of any kind leaves the server.
    expect(JSON.stringify(list.body)).not.toContain(cookie);
  });

  it('P64-C4-042 — one account’s trust cookie does nothing for another account', async () => {
    const a = await register('c4-042a');
    const b = await register('c4-042b');
    const cookie = readTrustCookie(await signInWithCode(a.email, a.userId, true));

    // B presents A's cookie: still challenged, because the row's owner
    // is part of the match rather than a check applied afterwards.
    await challenge(b.email, cookie);
  });

  it('P64-C4-043 — a trusted device is owner-scoped: it is invisible to, and unrevocable by, anyone else', async () => {
    const a = await register('c4-043a');
    const b = await register('c4-043b');
    const aSession = await signInWithCode(a.email, a.userId, true);
    const aDevices = await http()
      .get('/auth/trusted-devices')
      .set('Authorization', `Bearer ${aSession.body.accessToken}`)
      .expect(200);
    const deviceId = aDevices.body.items[0].id;

    const bSession = await signInWithCode(b.email, b.userId, false);
    const bDevices = await http()
      .get('/auth/trusted-devices')
      .set('Authorization', `Bearer ${bSession.body.accessToken}`)
      .expect(200);
    expect(bDevices.body.items).toHaveLength(0);

    // Not-found rather than forbidden: B must not learn that the id exists.
    await http()
      .delete(`/auth/trusted-devices/${deviceId}`)
      .set('Authorization', `Bearer ${bSession.body.accessToken}`)
      .expect(404);

    // And A's device is still standing.
    const stillThere = await admin.trustedDevice.findUniqueOrThrow({
      where: { id: deviceId },
    });
    expect(stillThere.revokedAt).toBeNull();
  });

  it('P64-C4-044 — "forget other devices" spares the browser that asked', async () => {
    const { email, userId } = await register('c4-044');
    const first = readTrustCookie(await signInWithCode(email, userId, true));
    const secondResponse = await signInWithCode(email, userId, true);
    const second = readTrustCookie(secondResponse);

    await http()
      .delete('/auth/trusted-devices')
      .set('Authorization', `Bearer ${secondResponse.body.accessToken}`)
      .set('Cookie', `${TRUST_COOKIE_NAME}=${second}`)
      .expect(204);

    // The browser that asked still skips the code; the other does not.
    const kept = await signIn(email, second).expect(200);
    expect(kept.body.accessToken).toEqual(expect.any(String));
    await challenge(email, first);
  });

  it('P64-C4-045 — trust is per surface: a management cookie is not trust on an academy website', async () => {
    const { email, userId } = await register('c4-045');
    const cookie = readTrustCookie(await signInWithCode(email, userId, true));

    await expect(
      trustedDevices.isTrusted({ userId, surface: 'management', cookieValue: cookie }),
    ).resolves.toBe(true);
    await expect(
      trustedDevices.isTrusted({ userId, surface: 'academy', cookieValue: cookie }),
    ).resolves.toBe(false);
  });

  it('P64-C4-046 — an expired trust row skips nothing', async () => {
    const { email, userId } = await register('c4-046');
    const cookie = readTrustCookie(await signInWithCode(email, userId, true));

    await admin.trustedDevice.updateMany({
      where: { userId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await challenge(email, cookie);
    // An expired row is also gone from the list the user is shown.
    const session = await signInWithCode(email, userId, false);
    const list = await http()
      .get('/auth/trusted-devices')
      .set('Authorization', `Bearer ${session.body.accessToken}`)
      .expect(200);
    expect(list.body.items).toHaveLength(0);
  });

  it('P64-C4-047 — changing the password forgets every remembered browser', async () => {
    const { email, userId } = await register('c4-047');
    const session = await signInWithCode(email, userId, true);
    const cookie = readTrustCookie(session);

    await http()
      .post('/users/me/password')
      .set('Authorization', `Bearer ${session.body.accessToken}`)
      .send({ currentPassword: PASSWORD, newPassword: `${PASSWORD}-2` })
      .expect(200);

    const rows = await admin.trustedDevice.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].revokedAt).not.toBeNull();

    // And the browser that held the cookie is challenged again.
    const response = await http()
      .post('/auth/sign-in')
      .set('Cookie', `${TRUST_COOKIE_NAME}=${cookie}`)
      .send({ email, password: `${PASSWORD}-2` })
      .expect(200);
    expect(response.body.emailOtpRequired).toBe(true);
  });

  // ---------------- the email itself, and the audit trail ----------------

  it('P64-C4-050 — dispatching the row produces one email that actually carries the code', async () => {
    const { email, userId } = await register('c4-050');
    await challenge(email);
    const code = await latestCode(userId);

    const rows = await admin.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "communication_outbox"
      WHERE "recipient_user_id" = ${userId} AND "key" = 'auth.email.otp'
      ORDER BY "created_at" DESC LIMIT 1
    `;
    const outcome = await dispatcher.dispatch(rows[0].id, DISPATCH_ATTEMPT);
    expect(outcome).toBe('sent');

    // The spy sees every email in the process, registration's
    // verification mail included; the dispatcher tags outbox sends with
    // the catalogue key, which is what picks this one out.
    const message = sent.find(
      (item) => item.to === email && (item.tags ?? []).includes('key:auth.email.otp'),
    );
    expect(message).toBeDefined();
    expect(message!.subject).toContain(code);
    expect(message!.text).toContain(code);
    expect(message!.html).toContain(code);
    // A sign-in code email must not teach people to click links.
    expect(message!.html).not.toContain('reset-password?token=');
  });

  it('P64-C4-051 — issue, verify and trust each leave an audit entry, and none of them records the code', async () => {
    const { email, userId } = await register('c4-051');
    await signInWithCode(email, userId, true);

    const code = await latestCode(userId);
    const entries = await admin.auditLogEntry.findMany({
      where: { actorUserId: userId },
      orderBy: { occurredAt: 'asc' },
    });
    const actions = entries.map((entry) => entry.action);
    expect(actions).toContain('auth.otp.issued');
    expect(actions).toContain('auth.otp.verified');
    expect(actions).toContain('auth.device.trusted');
    expect(JSON.stringify(entries)).not.toContain(code);
  });

  it('P64-C4-052 — a failed guess and a lockout are both audited', async () => {
    const { email, userId } = await register('c4-052');
    const open = await challenge(email);
    const code = await latestCode(userId);
    const wrong = code === '000000' ? '111111' : '000000';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await verify(open.challengeId, wrong).expect(401);
    }

    const actions = (
      await admin.auditLogEntry.findMany({ where: { actorUserId: userId } })
    ).map((entry) => entry.action);
    expect(actions).toContain('auth.otp.failed');
    expect(actions).toContain('auth.otp.locked_out');
  });

  it('P64-C4-053 — revoking a device is audited', async () => {
    const { email, userId } = await register('c4-053');
    const session = await signInWithCode(email, userId, true);
    const list = await http()
      .get('/auth/trusted-devices')
      .set('Authorization', `Bearer ${session.body.accessToken}`)
      .expect(200);

    await http()
      .delete(`/auth/trusted-devices/${list.body.items[0].id}`)
      .set('Authorization', `Bearer ${session.body.accessToken}`)
      .expect(204);

    const entries = await admin.auditLogEntry.findMany({
      where: { actorUserId: userId, action: 'auth.device.revoked' },
    });
    expect(entries.length).toBeGreaterThan(0);
  });

  // ---------------- abuse control ----------------

  it('P64-C4-060 — an account cannot open an unbounded number of challenges', async () => {
    const { email } = await register('c4-060');
    // §12: five challenges per account per hour. The sixth is refused
    // OUTRIGHT — never admitted without the factor the policy demands.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await signIn(email).expect(200);
    }
    const sixth = await signIn(email).expect(429);
    expect(err(sixth).messageKey).toBe('errors.auth.rateLimited');
  });

  it('P64-C4-061 — a new sign-in supersedes the challenge still open for that account', async () => {
    const { email, userId } = await register('c4-061');
    const first = await challenge(email);
    const firstCode = await latestCode(userId);

    const second = await challenge(email);
    expect(second.challengeId).not.toBe(first.challengeId);

    // Two live codes would double an attacker's budget for one password.
    const stale = await verify(first.challengeId, firstCode).expect(401);
    expect(err(stale).messageKey).toBe('errors.auth.otpAttemptsExceeded');
    await verify(second.challengeId, await latestCode(userId)).expect(200);
  });

  /**
   * Moves the challenge's derived "last sent at" back by `seconds`.
   *
   * The service derives it as `expires_at - codeTtl`, so rewinding the
   * expiry is exactly equivalent to time passing — and keeps the test
   * honest about WHICH value the cooldown reads, instead of stubbing a
   * clock the production code does not have.
   */
  async function rewindLastSend(userId: string, seconds: number): Promise<void> {
    const row = await latestChallengeRow(userId);
    await admin.authEmailChallenge.update({
      where: { id: row.id },
      data: { expiresAt: new Date(row.expiresAt.getTime() - seconds * 1000) },
    });
  }
});
