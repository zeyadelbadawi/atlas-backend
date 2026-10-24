/**
 * B1 — mobile app push notifications (docs/mobile/MOBILE_APP_BACKEND.md),
 * against real Postgres + Redis, with the stub provider.
 *
 *   PUSH-01  only an academy session registers a device; management → 403;
 *            signed out → 401; bad payloads → 400
 *   PUSH-02  re-registering updates; another account registering the same
 *            token on that phone takes it over (the first one's row goes)
 *   PUSH-03  RLS: own rows only; another account's device id → 404
 *   PUSH-04  FLAG_PUSH_MODE off → nothing sent
 *   PUSH-05  an academy notification reaches only devices on THAT academy,
 *            in each device's language, titled with the academy's name,
 *            with the path; nothing personal in the text
 *   PUSH-06  a device whose session was signed out gets nothing
 *   PUSH-07  a dead token is removed
 *   PUSH-08  account-wide notices reach every academy's device; management
 *            notifications reach none
 */
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { CommunicationsProcessor } from '../src/communications/queue/communications.processor';
import { CommunicationsScheduler } from '../src/communications/queue/communications.scheduler';
import { PushDeliveryService } from '../src/push/push-delivery.service';
import { PUSH_PROVIDER } from '../src/push/providers/push-provider';
import type { StubPushProvider } from '../src/push/providers/stub-push.provider';

jest.setTimeout(240000);

class InertCommunicationsProcessor {}
class InertCommunicationsScheduler {}

const PASSWORD = 'correct-horse-battery-push';
const BASE = 'pushdevices.test';
const ENV_KEYS = ['PLATFORM_BASE_DOMAIN', 'FLAG_AUTH_EMAIL_OTP_MODE_ACADEMY'] as const;
const token = (label: string) =>
  `fcm-token-${label}-${Date.now()}-${Math.random()}`.slice(0, 120);

describe('Push devices and delivery (e2e, B1)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let delivery: PushDeliveryService;
  let stub: StubPushProvider;
  let pushMode: string | undefined = 'on';

  beforeAll(async () => {
    const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    Object.assign(process.env, {
      PLATFORM_BASE_DOMAIN: BASE,
      FLAG_AUTH_EMAIL_OTP_MODE_ACADEMY: 'off',
    });
    const testApp = await createTestApp({
      overrides: (builder) =>
        builder
          .overrideProvider(CommunicationsProcessor)
          .useClass(InertCommunicationsProcessor)
          .overrideProvider(CommunicationsScheduler)
          .useClass(InertCommunicationsScheduler),
    });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    app = testApp.app;
    flush = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
    delivery = app.get(PushDeliveryService);
    stub = app.get(PUSH_PROVIDER);

    const config = app.get(ConfigService);
    const original = config.get.bind(config);
    jest.spyOn(config, 'get').mockImplementation(((key: string, ...rest: unknown[]) => {
      if (key === 'FLAG_PUSH_MODE') return pushMode;
      return (original as (...a: unknown[]) => unknown)(key, ...rest);
    }) as never);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
    pushMode = 'on';
    stub.sent.length = 0;
  });

  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function account(
    label: string,
    host = BASE,
    extra: Record<string, unknown> = {},
  ) {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .set('Host', host)
      .send({ name: label, email, password: PASSWORD, ...extra })
      .expect(201);
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    return { email, userId: user.id };
  }

  async function academy(label: string) {
    const owner = await account(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id);
    const a = await seedAcademy(admin, org.id, `${label}-academy`);
    await admin.academy.update({ where: { id: a.id }, data: { status: 'active' } });
    await seedAcademyMember(admin, a.id, owner.userId, 'owner');
    const host = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.custom.test`;
    await admin.domainConnection.create({
      data: { academyId: a.id, hostname: host, status: 'connected' },
    });
    const name = (await admin.academy.findUniqueOrThrow({ where: { id: a.id } })).name;
    return { id: a.id, host, owner, name };
  }

  async function academySession(email: string, a: { id: string; host: string }) {
    const res = await http()
      .post('/auth/sign-in')
      .set('Host', a.host)
      .send({ email, password: PASSWORD, surface: 'academy', academyId: a.id })
      .expect(200);
    return res.body.accessToken as string;
  }

  async function learnerOn(label: string, a: { id: string; host: string }) {
    const person = await account(label, a.host, { academyId: a.id });
    return { ...person, token: await academySession(person.email, a) };
  }

  function register(
    accessToken: string,
    host: string,
    body: Record<string, unknown>,
  ): request.Test {
    return http()
      .put('/users/me/push-devices')
      .set('Host', host)
      .set(bearer(accessToken))
      .send({ platform: 'android', appVersion: '1.0.0', locale: 'ar', ...body });
  }

  async function outbox(
    key: string,
    recipientUserId: string,
    academyId: string | null,
  ): Promise<string> {
    const row = await admin.communicationOutbox.create({
      data: {
        key,
        category: 'transactional',
        recipientUserId,
        academyId,
        entityType: 'test',
        entityId: `e-${Math.random()}`,
        channels: { inApp: true, email: 'always' },
        state: 'dispatched',
        values: { amount: '1500 EGP', courseTitle: 'Secret Course' },
      },
    });
    return row.id;
  }

  it('PUSH-01 — only an academy session registers; others are refused', async () => {
    const a = await academy('p01');
    const learner = await learnerOn('p01-learner', a);
    const res = await register(learner.token, a.host, { token: token('p01') }).expect(
      200,
    );
    expect(res.body).toMatchObject({
      platform: 'android',
      locale: 'ar',
      appVersion: '1.0.0',
    });
    expect(res.body.token).toBeUndefined();

    const mgmt = await http()
      .post('/auth/sign-in')
      .set('Host', BASE)
      .send({ email: a.owner.email, password: PASSWORD })
      .expect(200);
    await register(mgmt.body.accessToken, BASE, { token: token('p01m') }).expect(403);

    await http()
      .put('/users/me/push-devices')
      .send({ token: token('x') })
      .expect(401);
    await register(learner.token, a.host, { token: 'short' }).expect(400);
    await register(learner.token, a.host, {
      token: token('p01b'),
      platform: 'web',
    }).expect(400);
    await register(learner.token, a.host, { token: token('p01c'), locale: 'fr' }).expect(
      400,
    );
    await register(learner.token, a.host, { token: token('p01d'), extra: 1 }).expect(400);
  });

  it('PUSH-02 — the same token moves to whoever signs in on that phone', async () => {
    const a = await academy('p02');
    const first = await learnerOn('p02-first', a);
    const second = await learnerOn('p02-second', a);
    const shared = token('p02');
    await register(first.token, a.host, { token: shared }).expect(200);
    await register(first.token, a.host, { token: shared, appVersion: '1.0.1' }).expect(
      200,
    );
    expect(await admin.pushDevice.count({ where: { token: shared } })).toBe(1);

    await register(second.token, a.host, { token: shared }).expect(200);
    const rows = await admin.pushDevice.findMany({ where: { token: shared } });
    expect(rows.map((r) => r.userId)).toEqual([second.userId]);
  });

  it('PUSH-03 — own rows only', async () => {
    const a = await academy('p03');
    const owner = await learnerOn('p03-a', a);
    const other = await learnerOn('p03-b', a);
    const res = await register(owner.token, a.host, { token: token('p03') }).expect(200);
    await http()
      .delete(`/users/me/push-devices/${res.body.id}`)
      .set('Host', a.host)
      .set(bearer(other.token))
      .expect(404);
    expect(await admin.pushDevice.count({ where: { id: res.body.id } })).toBe(1);
    await http()
      .delete(`/users/me/push-devices/${res.body.id}`)
      .set('Host', a.host)
      .set(bearer(owner.token))
      .expect(204);
    expect(await admin.pushDevice.count({ where: { id: res.body.id } })).toBe(0);
  });

  it('PUSH-04 — with the flag off nothing is sent', async () => {
    const a = await academy('p04');
    const learner = await learnerOn('p04-l', a);
    await register(learner.token, a.host, { token: token('p04') }).expect(200);
    pushMode = undefined;
    expect(
      await delivery.deliver(
        await outbox('course.payment.approved', learner.userId, a.id),
      ),
    ).toBe('disabled');
    expect(stub.sent).toHaveLength(0);
  });

  it('PUSH-05 — reaches only that academy, in the device language, nothing personal', async () => {
    const a = await academy('p05a');
    const b = await academy('p05b');
    const learner = await learnerOn('p05-l', a);
    // The same person also learns at academy B.
    await http()
      .post('/auth/register')
      .set('Host', b.host)
      .send({ name: 'p05-l', email: learner.email, password: PASSWORD, academyId: b.id })
      .expect(201);
    const onB = await academySession(learner.email, b);
    const tokenA = token('p05a');
    await register(learner.token, a.host, { token: tokenA, locale: 'ar' }).expect(200);
    await register(onB, b.host, { token: token('p05b'), locale: 'en' }).expect(200);

    const outcome = await delivery.deliver(
      await outbox('course.payment.approved', learner.userId, a.id),
    );
    expect(outcome).toEqual({ sent: 1, removed: 0, failed: 0 });
    expect(stub.sent).toHaveLength(1);
    const [message] = stub.sent;
    expect(message.token).toBe(tokenA);
    expect(message.title).toBe(a.name);
    expect(message.body).toBe('يوجد تحديث بخصوص عملية دفع.');
    expect(message.data).toEqual({
      kind: 'notification',
      context: 'academy',
      academyId: a.id,
      path: '/my/payments',
    });
    expect(JSON.stringify(message)).not.toMatch(/1500|Secret Course/);
  });

  it('PUSH-06 — a signed-out session gets nothing', async () => {
    const a = await academy('p06');
    const learner = await learnerOn('p06-l', a);
    await register(learner.token, a.host, { token: token('p06') }).expect(200);
    await http()
      .post('/auth/sign-out')
      .set('Host', a.host)
      .set(bearer(learner.token))
      .expect(200);
    expect(
      await delivery.deliver(
        await outbox('course.payment.approved', learner.userId, a.id),
      ),
    ).toBe('no_devices');
    expect(stub.sent).toHaveLength(0);
  });

  it('PUSH-07 — a dead token is removed', async () => {
    const a = await academy('p07');
    const learner = await learnerOn('p07-l', a);
    await register(learner.token, a.host, { token: `invalid-${token('p07')}` }).expect(
      200,
    );
    expect(
      await delivery.deliver(
        await outbox('course.payment.approved', learner.userId, a.id),
      ),
    ).toEqual({ sent: 0, removed: 1, failed: 0 });
    expect(await admin.pushDevice.count({ where: { userId: learner.userId } })).toBe(0);
  });

  it('PUSH-08 — account notices reach every device; management ones none', async () => {
    const a = await academy('p08');
    const learner = await learnerOn('p08-l', a);
    await register(learner.token, a.host, { token: token('p08'), locale: 'en' }).expect(
      200,
    );

    const outcome = await delivery.deliver(
      await outbox('auth.password.changed', learner.userId, null),
    );
    expect(outcome).toEqual({ sent: 1, removed: 0, failed: 0 });
    expect(stub.sent[0]).toMatchObject({
      title: 'Atlas',
      body: 'Security notice for your account.',
    });

    stub.sent.length = 0;
    expect(
      await delivery.deliver(await outbox('course.order.paid', learner.userId, null)),
    ).toBe('skipped');
    expect(stub.sent).toHaveLength(0);
  });
});
