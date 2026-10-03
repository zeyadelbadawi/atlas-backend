/**
 * Email verification link security — end to end against the real
 * `AppModule`, real Postgres (FORCE RLS), real Redis and the real outbox
 * dispatcher.
 *
 * DELIVERY IS DRIVEN BY THE TEST, not by the background worker. The
 * producer, processor and scheduler are replaced with inert classes and
 * each pending verification row is handed to the real
 * `CommunicationDispatchService.dispatch` in this process. The BullMQ
 * queue and the database are shared with whatever else runs against the
 * same stack (a dev server, another spec file's app), and a worker in
 * another process would otherwise claim these rows and send the email to
 * ITS stub — the spec would test a race, not a rule. Same reasoning as
 * `p64-comm-outbox.e2e-spec.ts` / `p64-c4-email-otp.e2e-spec.ts`.
 *
 * What each case pins, and why it is here rather than in a unit test:
 *
 *  - EVL-001..004 — valid / expired / replayed / malformed. The
 *    single-use claim and the "verified" stamp are ONE transaction in SQL;
 *    only real Postgres proves it. Unknown and malformed tokens must be
 *    byte-for-byte the same refusal; expired/used are reported only to a
 *    token whose hash matched a real row.
 *  - EVL-005 — a resend retires the previous link.
 *  - EVL-006 — the same link submitted concurrently verifies exactly once.
 *  - EVL-007 — concurrent resends leave exactly ONE live token (the
 *    user-row lock in `rotateForUser`).
 *  - EVL-008 — once the email is sent, the outbox row no longer holds the
 *    raw token (`credentialValues`).
 *  - EVL-009 — `POST /auth/verify-email` has its own throttle.
 *  - EVL-010 — an academy-website signup's link lands on that academy's
 *    own `/verify-email`, not on the management host.
 *  - EVL-011 — resend has its own per-account budget, separate from
 *    password reset's.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { StubEmailProvider } from '../src/identity/services/stub-email.provider';
import { hashOpaqueToken } from '../src/identity/utils/opaque-token.util';
import { CommunicationsProcessor } from '../src/communications/queue/communications.processor';
import { CommunicationsProducer } from '../src/communications/queue/communications.producer';
import { CommunicationsScheduler } from '../src/communications/queue/communications.scheduler';
import { CommunicationDispatchService } from '../src/communications/services/communication-dispatch.service';
import { RedisService } from '../src/redis/redis.service';

jest.setTimeout(60000);

class InertCommunicationsProcessor {}
class InertCommunicationsScheduler {}
class InertCommunicationsProducer {
  async enqueueDispatch(): Promise<boolean> {
    return true;
  }
}

const PASSWORD = 'correct-horse-battery-evl';
const DISPATCH_ATTEMPT = { made: 0, max: 6 } as const;

describe('Email verification link security (e2e) — EVL-001..011', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let stubEmail: StubEmailProvider;
  let dispatcher: CommunicationDispatchService;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp({
      overrides: (builder) =>
        builder
          .overrideProvider(CommunicationsProcessor)
          .useClass(InertCommunicationsProcessor)
          .overrideProvider(CommunicationsScheduler)
          .useClass(InertCommunicationsScheduler)
          .overrideProvider(CommunicationsProducer)
          .useClass(InertCommunicationsProducer),
    });
    app = testApp.app;
    admin = createAdminPrisma();
    stubEmail = testApp.stubEmailProvider;
    dispatcher = app.get(CommunicationDispatchService, { strict: false });
    const redis = app.get(RedisService, { strict: false }).getClient();
    flushRateLimitKeys = async () => {
      await testApp.flushRateLimitKeys();
      // The shared helper clears the throttler's `:hits` counters but not
      // the `:blocked` marker a 429 leaves behind for the window's length.
      // EVL-009 trips that block on purpose; without this it would leak
      // into the next case — and the next spec file — for 60 seconds.
      const blocked = await redis.keys('{*}:blocked');
      if (blocked.length > 0) await redis.del(...blocked);
    };
  });

  afterAll(async () => {
    await flushRateLimitKeys();
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  const http = () => request(app.getHttpServer());
  const verify = (token: unknown) => http().post('/auth/verify-email').send({ token });
  const messageKey = (response: request.Response): string | undefined =>
    response.body?.error?.messageKey;

  async function register(label: string, academyId?: string) {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .send({ name: 'Verify Tester', email, password: PASSWORD, academyId })
      .expect(201);
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    return { email, userId: user.id };
  }

  /**
   * Dispatches this account's pending verification emails through the
   * real dispatcher and returns the token the stub received — one other
   * than `previous`, so a resend is proven to have sent a NEW link.
   */
  async function waitForToken(email: string, previous?: string): Promise<string> {
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    const pending = await admin.communicationOutbox.findMany({
      where: {
        recipientUserId: user.id,
        key: 'auth.email.verification',
        state: 'pending',
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    for (const row of pending) {
      await dispatcher.dispatch(row.id, DISPATCH_ATTEMPT);
    }
    const token = stubEmail.peekLastEmailVerificationToken(email);
    if (!token || token === previous) {
      throw new Error(`No (new) verification email reached the stub for ${email}`);
    }
    return token;
  }

  async function signIn(email: string): Promise<string> {
    const response = await http()
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    const accessToken = response.body.accessToken as string | undefined;
    if (!accessToken) throw new Error('Sign-in did not return an access token.');
    return accessToken;
  }

  const resend = (accessToken: string) =>
    http()
      .post('/auth/verify-email/resend')
      .set('Authorization', `Bearer ${accessToken}`);

  function liveTokenCount(userId: string): Promise<number> {
    return admin.emailVerificationToken.count({
      where: { userId, usedAt: null, expiresAt: { gt: new Date() } },
    });
  }

  it('EVL-001 — a valid link verifies the address and is consumed in the same step', async () => {
    const { email, userId } = await register('evl001');
    const token = await waitForToken(email);

    await verify(token).expect(200);

    const user = await admin.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    const row = await admin.emailVerificationToken.findUniqueOrThrow({
      where: { tokenHash: hashOpaqueToken(token) },
    });
    expect(row.usedAt).toBeInstanceOf(Date);
  });

  it('EVL-002 — an expired link is refused as expired and verifies nothing', async () => {
    const { email, userId } = await register('evl002');
    const token = await waitForToken(email);
    await admin.emailVerificationToken.updateMany({
      where: { userId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const response = await verify(token).expect(400);
    expect(messageKey(response)).toBe('errors.auth.verificationTokenExpired');
    expect(
      (await admin.user.findUniqueOrThrow({ where: { id: userId } })).emailVerifiedAt,
    ).toBeNull();
  });

  it('EVL-003 — a replayed link is refused as already used', async () => {
    const { email } = await register('evl003');
    const token = await waitForToken(email);
    await verify(token).expect(200);

    const replay = await verify(token).expect(400);
    expect(messageKey(replay)).toBe('errors.auth.verificationTokenUsed');
  });

  it('EVL-004 — malformed and unknown tokens get one identical refusal', async () => {
    const unknown = await verify('A'.repeat(43)).expect(400);
    expect(messageKey(unknown)).toBe('errors.auth.invalidVerificationToken');

    for (const malformed of [
      '',
      'short',
      'has spaces and !!! symbols',
      'x'.repeat(600),
    ]) {
      const response = await verify(malformed);
      expect({ status: response.status, key: messageKey(response) }).toEqual({
        status: 400,
        key: 'errors.auth.invalidVerificationToken',
      });
      // No field-level violation that would say WHICH check failed.
      expect(response.body.error.violations ?? []).toEqual([]);
      expect(JSON.stringify(response.body)).not.toContain('symbols');
    }
  });

  it('EVL-005 — a resend retires the previous link; only the new one verifies', async () => {
    const { email, userId } = await register('evl005');
    const first = await waitForToken(email);
    const accessToken = await signIn(email);

    await resend(accessToken).expect(202);
    const second = await waitForToken(email, first);
    expect(second).not.toBe(first);
    expect(await liveTokenCount(userId)).toBe(1);

    // The retired link reads as "request a new one", never as success.
    const old = await verify(first).expect(400);
    expect(messageKey(old)).toBe('errors.auth.verificationTokenExpired');
    expect(
      (await admin.user.findUniqueOrThrow({ where: { id: userId } })).emailVerifiedAt,
    ).toBeNull();

    await verify(second).expect(200);
  });

  it('EVL-006 — the same link submitted concurrently verifies exactly once', async () => {
    const { email, userId } = await register('evl006');
    const token = await waitForToken(email);

    const responses = await Promise.all(Array.from({ length: 5 }, () => verify(token)));
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 400, 400, 400, 400]);
    for (const response of responses.filter((r) => r.status === 400)) {
      expect(messageKey(response)).toBe('errors.auth.verificationTokenUsed');
    }
    expect(
      (await admin.user.findUniqueOrThrow({ where: { id: userId } })).emailVerifiedAt,
    ).toBeInstanceOf(Date);
  });

  it('EVL-007 — concurrent resends leave exactly one live token', async () => {
    const { email, userId } = await register('evl007');
    await waitForToken(email);
    const accessToken = await signIn(email);

    const responses = await Promise.all([
      resend(accessToken),
      resend(accessToken),
      resend(accessToken),
    ]);
    expect(responses.map((response) => response.status)).toEqual([202, 202, 202]);

    expect(await liveTokenCount(userId)).toBe(1);
    // Every issued token is accounted for: registration's + three resends,
    // all but one retired.
    expect(await admin.emailVerificationToken.count({ where: { userId } })).toBe(4);
  });

  it('EVL-008 — once the email is sent, the outbox row no longer holds the raw token', async () => {
    const { email, userId } = await register('evl008');

    // Until the send, the row must still carry the token — the render
    // needs it, and a transient failure's retry re-renders it.
    const before = await admin.communicationOutbox.findFirstOrThrow({
      where: { recipientUserId: userId, key: 'auth.email.verification' },
    });
    expect(before.state).toBe('pending');
    expect(before.values).toHaveProperty('token');

    const token = await waitForToken(email);
    const row = await admin.communicationOutbox.findUniqueOrThrow({
      where: { id: before.id },
    });

    expect(row.state).toBe('dispatched');
    const values = row.values as Record<string, unknown>;
    expect(values).not.toHaveProperty('token');
    // Everything that is not a credential survives, including the
    // validity the template stated.
    expect(values.expiresInHours).toBe(24);
    expect(JSON.stringify(row)).not.toContain(token);
    // …and the link the person received still works.
    await verify(token).expect(200);
  });

  it('EVL-009 — POST /auth/verify-email is throttled per client', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      statuses.push((await verify(`${'B'.repeat(40)}${attempt}xx`)).status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(400));
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it("EVL-010 — an academy-website signup's link lands on that academy's own verify page", async () => {
    const owner = await admin.user.create({
      data: { email: uniqueTestEmail('evl010-owner'), name: 'Owner' },
    });
    const org = await seedOrganizationWithOwner(admin, owner.id, 'evl010-org');
    const academy = await seedAcademy(admin, org.id, 'evl010-academy');
    const label = `evl010-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const academyHost = `${label}.academies.atlas.test`;
    await admin.subdomainAllocation.create({
      data: {
        academyId: academy.id,
        subdomain: label,
        fullHost: academyHost,
        status: 'assigned',
      },
    });

    const { email, userId } = await register('evl010', academy.id);
    const token = await waitForToken(email);

    const sent = stubEmail
      .recordedSends()
      .filter((input) => input.to.toLowerCase() === email.toLowerCase());
    const body = sent.map((input) => `${input.html ?? ''}\n${input.text}`).join('\n');
    expect(body).toContain(`https://${academyHost}/verify-email?token=${token}`);
    expect(body).not.toContain('/auth/verify-email');

    const row = await admin.communicationOutbox.findFirstOrThrow({
      where: { recipientUserId: userId, key: 'auth.email.verification' },
    });
    expect(row.academyId).toBe(academy.id);
    // Never tenant-visible: the row carried a live link.
    expect(row.organizationId).toBeNull();

    await verify(token).expect(200);
  });

  it('EVL-011 — resend has its own per-account budget, independent of password reset', async () => {
    const { email } = await register('evl011');
    await waitForToken(email);
    const accessToken = await signIn(email);

    // Spending the password-reset budget does not touch resend's.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await http().post('/auth/password-reset/request').send({ email });
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await resend(accessToken).expect(202);
    }
    const refused = await resend(accessToken).expect(429);
    expect(messageKey(refused)).toBe('errors.auth.rateLimited');
  });
});
