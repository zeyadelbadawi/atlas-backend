/**
 * Notification context isolation — end to end, real AppModule, Postgres
 * with FORCE RLS, Redis.
 *
 * One person, U, is at the same time:
 *   - a Management user (they own an organization and an academy), and
 *   - a learner at Academy A, and
 *   - a learner at Academy B.
 * Every feed read and write is decided by the SESSION's own context:
 *
 *   Management session         → Management notifications only
 *   Academy A session (A host) → Academy A notifications only
 *   Academy B session (B host) → Academy B notifications only
 *
 * (each plus the account's own security notices, which belong to the
 * global credential). This holds for the list, the unread count,
 * mark-as-read and mark-all-read; no parameter selects another context;
 * an A-session token presented to B's host is refused; and creation places
 * a staff event about Academy A in Management, not in A.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedAcademyStudent,
  seedActiveSubscriptionForOrg,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { CommunicationService } from '../src/communications/services/communication.service';
import { NotificationFanoutService } from '../src/notification-events/services/notification-fanout.service';

jest.setTimeout(120000);

const PASSWORD = 'correct-horse-battery-nci';

describe('Notification context isolation (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let tenancy: TenancyContextService;
  let communications: CommunicationService;
  let fanout: NotificationFanoutService;
  let previousAcademyFlag: string | undefined;

  beforeAll(async () => {
    previousAcademyFlag = process.env.FLAG_AUTH_EMAIL_OTP_MODE_ACADEMY;
    process.env.FLAG_AUTH_EMAIL_OTP_MODE_ACADEMY = 'off';
    const testApp = await createTestApp();
    app = testApp.app;
    flush = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
    tenancy = app.get(TenancyContextService);
    communications = app.get(CommunicationService);
    fanout = app.get(NotificationFanoutService);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
    if (previousAcademyFlag === undefined) {
      delete process.env.FLAG_AUTH_EMAIL_OTP_MODE_ACADEMY;
    } else {
      process.env.FLAG_AUTH_EMAIL_OTP_MODE_ACADEMY = previousAcademyFlag;
    }
  });

  beforeEach(async () => {
    await flush();
  });

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  interface Academy {
    readonly id: string;
    readonly host: string;
  }

  async function academyOwnedBy(ownerUserId: string, label: string): Promise<Academy> {
    const org = await seedOrganizationWithOwner(admin, ownerUserId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await admin.academy.update({ where: { id: academy.id }, data: { status: 'active' } });
    await seedAcademyMember(admin, academy.id, ownerUserId, 'owner');
    const host = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.nci.test`;
    await admin.domainConnection.create({
      data: { academyId: academy.id, hostname: host, status: 'connected' },
    });
    return { id: academy.id, host };
  }

  async function register(label: string): Promise<{ email: string; userId: string }> {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    await admin.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date() },
    });
    return { email, userId: user.id };
  }

  async function managementSession(email: string): Promise<string> {
    const res = await http()
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.accessToken as string;
  }

  async function academySession(a: Academy, email: string): Promise<string> {
    const res = await http()
      .post('/auth/sign-in')
      .set('Host', a.host)
      .send({ email, password: PASSWORD, surface: 'academy', academyId: a.id })
      .expect(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    return res.body.accessToken as string;
  }

  type Ctx = 'management' | 'academy' | 'account';
  async function seed(
    userId: string,
    context: Ctx,
    academyId: string | null,
    label: string,
  ): Promise<string> {
    await tenancy.runInUserContext(userId, (tx) =>
      fanout.notify(tx, {
        userId,
        context,
        academyId,
        type: 'system',
        priority: 'medium',
        titleKey: 'notifications:events.provisioningCompleted.title',
        messageKey: 'notifications:events.provisioningCompleted.message',
        values: { academyName: label },
        dedupeKey: `nci:${label}:${userId}`,
      }),
    );
    const row = await admin.notification.findFirstOrThrow({
      where: { userId, dedupeKey: `nci:${label}:${userId}` },
    });
    return row.id;
  }

  /** The context of every returned row, read back from the database. */
  async function contextsOf(res: request.Response): Promise<string[]> {
    const ids = (res.body.items as { id: string }[]).map((n) => n.id);
    const rows = await admin.notification.findMany({ where: { id: { in: ids } } });
    expect(rows).toHaveLength(ids.length);
    return rows.map((r) =>
      r.context === 'academy' ? `academy:${r.academyId}` : r.context,
    );
  }

  function labels(res: request.Response): string[] {
    // Only the rows this suite seeded (an academy sign-in also registers a
    // device, which notifies in that academy — correctly).
    return (res.body.items as { values?: { academyName?: string } }[])
      .map((n) => n.values?.academyName)
      .filter((v): v is string => ['M', 'A', 'B', 'ACC', 'LEGACY'].includes(v ?? ''))
      .sort();
  }

  /** U: Management (owns Owned), learner at A and at B; one notification of each kind. */
  async function world(label: string) {
    const owner = await register(`${label}-owner`);
    const a = await academyOwnedBy(owner.userId, `${label}-a`);
    const b = await academyOwnedBy(owner.userId, `${label}-b`);
    const u = await register(`${label}-u`);
    await academyOwnedBy(u.userId, `${label}-owned`);
    await seedAcademyStudent(admin, a.id, u.userId);
    await seedAcademyStudent(admin, b.id, u.userId);
    const ids = {
      management: await seed(u.userId, 'management', null, 'M'),
      academyA: await seed(u.userId, 'academy', a.id, 'A'),
      academyB: await seed(u.userId, 'academy', b.id, 'B'),
      account: await seed(u.userId, 'account', null, 'ACC'),
    };
    // A legacy row whose context could not be determined: shown nowhere.
    await admin.notification.create({
      data: {
        userId: u.userId,
        type: 'system',
        priority: 'low',
        titleKey: 'notifications:events.provisioningCompleted.title',
        messageKey: 'notifications:events.provisioningCompleted.message',
        values: { academyName: 'LEGACY' },
      },
    });
    return {
      u,
      a,
      b,
      ids,
      management: await managementSession(u.email),
      tokenA: await academySession(a, u.email),
      tokenB: await academySession(b, u.email),
    };
  }

  it('NCI-01 — Management → Management only; Academy A → A only; Academy B → B only (plus account notices)', async () => {
    const w = await world('nci01');

    const mgmt = await http().get('/notifications').set(bearer(w.management)).expect(200);
    expect(labels(mgmt)).toEqual(['ACC', 'M']);
    for (const ctx of await contextsOf(mgmt))
      expect(['management', 'account']).toContain(ctx);

    const inA = await http()
      .get('/notifications')
      .set('Host', w.a.host)
      .set(bearer(w.tokenA))
      .expect(200);
    expect(labels(inA)).toEqual(['A', 'ACC']);
    for (const ctx of await contextsOf(inA))
      expect([`academy:${w.a.id}`, 'account']).toContain(ctx);

    const inB = await http()
      .get('/notifications')
      .set('Host', w.b.host)
      .set(bearer(w.tokenB))
      .expect(200);
    expect(labels(inB)).toEqual(['ACC', 'B']);
    for (const ctx of await contextsOf(inB))
      expect([`academy:${w.b.id}`, 'account']).toContain(ctx);
  });

  it('NCI-02 — the unread count is per context', async () => {
    const w = await world('nci02');
    const summary = async (token: string, host?: string) => {
      const req = http().get('/notifications/summary').set(bearer(token));
      return (await (host ? req.set('Host', host) : req).expect(200)).body;
    };
    // Exactly the rows of that context (+ account notices) — counted in the DB.
    const count = (where: object) =>
      admin.notification.count({
        where: { userId: w.u.userId, isRead: false, ...where },
      });
    const account = { context: 'account' as const };
    const expected = {
      management: await count({ OR: [{ context: 'management' }, account] }),
      a: await count({ OR: [{ context: 'academy', academyId: w.a.id }, account] }),
      b: await count({ OR: [{ context: 'academy', academyId: w.b.id }, account] }),
    };
    expect(expected.management).toBe(2);
    expect((await summary(w.management)).unread).toBe(expected.management);
    expect((await summary(w.tokenA, w.a.host)).unread).toBe(expected.a);
    expect((await summary(w.tokenB, w.b.host)).unread).toBe(expected.b);
    // Each academy count leaves out the other academy's and Management's rows.
    const all = await count({});
    expect(expected.a).toBeLessThan(all);
    expect(expected.b).toBeLessThan(all);
  });

  it("NCI-03 — mark-as-read cannot reach another context's notification, even by id", async () => {
    const w = await world('nci03');
    // Academy A's session tries Management's and Academy B's rows.
    for (const id of [w.ids.management, w.ids.academyB]) {
      await http()
        .patch(`/notifications/${id}/read`)
        .set('Host', w.a.host)
        .set(bearer(w.tokenA))
        .expect(404);
    }
    // Management's session tries Academy A's row.
    await http()
      .patch(`/notifications/${w.ids.academyA}/read`)
      .set(bearer(w.management))
      .expect(404);
    const untouched = await admin.notification.findMany({
      where: { id: { in: [w.ids.management, w.ids.academyA, w.ids.academyB] } },
    });
    expect(untouched.every((n) => !n.isRead)).toBe(true);

    // Its own row: fine.
    await http()
      .patch(`/notifications/${w.ids.academyA}/read`)
      .set('Host', w.a.host)
      .set(bearer(w.tokenA))
      .expect(200);
  });

  it("NCI-04 — mark-all-read in Academy A leaves Management's and Academy B's unread", async () => {
    const w = await world('nci04');
    await http()
      .post('/notifications/read-all')
      .set('Host', w.a.host)
      .set(bearer(w.tokenA))
      .expect(201);
    const rows = await admin.notification.findMany({ where: { userId: w.u.userId } });
    const read = (id: string) => rows.find((r) => r.id === id)?.isRead;
    expect(read(w.ids.academyA)).toBe(true);
    expect(read(w.ids.account)).toBe(true);
    expect(read(w.ids.management)).toBe(false);
    expect(read(w.ids.academyB)).toBe(false);
  });

  it('NCI-05 — no parameter selects another context; an A token on B’s host is refused', async () => {
    const w = await world('nci05');
    // An unknown query parameter is refused outright, never honoured.
    await http()
      .get('/notifications')
      .query({ academyId: w.b.id })
      .set('Host', w.a.host)
      .set(bearer(w.tokenA))
      .expect(400);
    // A session minted on A, presented on B's host.
    const cross = await http()
      .get('/notifications')
      .set('Host', w.b.host)
      .set(bearer(w.tokenA));
    expect(cross.status).toBe(403);
    expect(JSON.stringify(cross.body)).not.toContain('"B"');
  });

  it("NCI-06 — another academy (C): never Management's, A's or B's notifications", async () => {
    const w = await world('nci06');
    const owner = await register('nci06-other-owner');
    const c = await academyOwnedBy(owner.userId, 'nci06-c');
    const res = await http().post('/auth/sign-in').set('Host', c.host).send({
      email: w.u.email,
      password: PASSWORD,
      surface: 'academy',
      academyId: c.id,
    });
    if (res.body.accessToken) {
      // Whatever the sign-in policy admits, a session on C reads C's
      // context only: none of Management's, A's or B's notifications.
      const onC = await http()
        .get('/notifications')
        .set('Host', c.host)
        .set(bearer(res.body.accessToken as string))
        .expect(200);
      expect(labels(onC)).toEqual(['ACC']);
      for (const ctx of await contextsOf(onC)) {
        expect([`academy:${c.id}`, 'account']).toContain(ctx);
      }
    }
    // And the Management token on C's host still reads only Management.
    const mgmtOnC = await http()
      .get('/notifications')
      .set('Host', c.host)
      .set(bearer(w.management))
      .expect(200);
    expect(labels(mgmtOnC)).toEqual(['ACC', 'M']);
  });

  it('NCI-07 — creation: a staff event about Academy A goes to Management; the learner event of the same academy to A', async () => {
    const owner = await register('nci07-owner');
    const a = await academyOwnedBy(owner.userId, 'nci07-a');
    await seedAcademyStudent(admin, a.id, owner.userId);
    await tenancy.runInUserContext(owner.userId, async (tx) => {
      await communications.emit(tx, {
        key: 'academy.payment.submitted',
        recipientUserId: owner.userId,
        academyId: a.id,
        entity: { type: 'course_order', id: `nci07-staff-${owner.userId}` },
        values: { learnerName: 'L', courseTitle: 'C' },
      });
      await communications.emit(tx, {
        key: 'course.payment.approved',
        recipientUserId: owner.userId,
        academyId: a.id,
        entity: { type: 'course_order', id: `nci07-learner-${owner.userId}` },
        values: { courseTitle: 'C' },
      });
      await communications.emit(tx, {
        key: 'auth.password.changed',
        recipientUserId: owner.userId,
        entity: { type: 'user', id: owner.userId },
      });
    });
    const rows = await admin.notification.findMany({ where: { userId: owner.userId } });
    const byTitle = (fragment: string) => rows.find((r) => r.titleKey.includes(fragment));
    expect(rows).toHaveLength(3);
    const staff = rows.find((r) => r.context === 'management');
    const learner = rows.find((r) => r.context === 'academy');
    const account = rows.find((r) => r.context === 'account');
    expect(staff?.academyId).toBeNull();
    expect(learner?.academyId).toBe(a.id);
    expect(account?.academyId).toBeNull();
    expect(byTitle('passwordChanged')?.context).toBe('account');
  });

  it('NCI-08 — a learner row without its academy is refused by the database (CHECK)', async () => {
    const u = await register('nci08');
    await expect(
      admin.notification.create({
        data: {
          userId: u.userId,
          type: 'system',
          priority: 'low',
          titleKey: 't',
          messageKey: 'm',
          context: 'academy',
        },
      }),
    ).rejects.toThrow();
  });
  it('NCI-09 — backfill: legacy rows are placed only where certain; the rest stay unscoped (shown nowhere)', async () => {
    const owner = await register('nci09-owner');
    const a = await academyOwnedBy(owner.userId, 'nci09-a');
    const u = await register('nci09-u');
    const legacy = (titleKey: string, dedupeKey: string | null, metadata?: object) =>
      admin.notification.create({
        data: {
          userId: u.userId,
          type: 'system',
          priority: 'low',
          titleKey,
          messageKey: titleKey.replace('.title', '.message'),
          dedupeKey,
          ...(metadata ? { metadata } : {}),
        },
      });
    const staff = await legacy(
      'notifications:events.academyPaymentSubmitted.title',
      'nci09-s',
    );
    const account = await legacy('notifications:events.passwordChanged.title', null);
    const learnerWithOutbox = await legacy(
      'notifications:events.certificateIssued.title',
      `nci09-cert-${u.userId}`,
    );
    const learnerOrphan = await legacy(
      'notifications:events.certificateIssued.title',
      `nci09-orphan-${u.userId}`,
    );
    await admin.communicationOutbox.create({
      data: {
        key: 'certificate.issued',
        category: 'transactional',
        recipientUserId: u.userId,
        academyId: a.id,
        dedupeKey: `nci09-cert-${u.userId}`,
        locale: 'en',
        branding: 'academy',
        channels: { inApp: true, email: 'always' },
        priority: 'medium',
        state: 'dispatched',
      },
    });

    // The migration's own backfill statements, run again (they only touch
    // rows still `unscoped`, so re-running them is safe).
    const sql = readFileSync(
      join(
        __dirname,
        '../prisma/migrations/20261106100000_notification_context/migration.sql',
      ),
      'utf8',
    );
    const updates = sql
      .split(/;\s*\n/)
      .map((statement) => statement.replace(/^(--.*\n|\s*\n)*/g, '').trim())
      .filter((statement) => statement.startsWith('UPDATE'));
    expect(updates).toHaveLength(4);
    for (const statement of updates) await admin.$executeRawUnsafe(statement);

    const read = async (id: string) =>
      admin.notification.findUniqueOrThrow({ where: { id } });
    expect(await read(staff.id)).toMatchObject({
      context: 'management',
      academyId: null,
    });
    expect(await read(account.id)).toMatchObject({ context: 'account', academyId: null });
    expect(await read(learnerWithOutbox.id)).toMatchObject({
      context: 'academy',
      academyId: a.id,
    });
    // No recorded academy: never guessed.
    expect(await read(learnerOrphan.id)).toMatchObject({
      context: 'unscoped',
      academyId: null,
    });
  });
});
