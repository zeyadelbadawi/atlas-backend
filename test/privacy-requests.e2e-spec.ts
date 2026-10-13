/**
 * B0-SEC-13 — request-based data deletion and data export. Real PostgreSQL
 * (RLS as `atlas_app`) and Redis.
 *
 *   PRIV-01  a learner files from an academy session only with a fresh
 *            emailed code; a retry returns the open request; receipt + audit
 *   PRIV-02  purpose binding: an account-deletion code cannot file a
 *            request, and a privacy-request code cannot delete the account
 *   PRIV-03  RLS: only the requester and Platform Owners can read a
 *            request — not another learner, not the academy's owner, not a
 *            context-free connection; the tenant cannot reach the queue
 *   PRIV-04  export: nothing to download until fulfilled; the bundle holds
 *            only the requester's rows; it expires; no one else can fetch it
 *   PRIV-05  deletion completes through the existing Platform Owner path,
 *            audited, the address masked, a goodbye email to the snapshot
 *   PRIV-06  declining needs a reason, which the person is emailed and sees
 *   PRIV-07  every active Platform Owner is alerted, with no personal data
 *   PRIV-08  the table has FORCE RLS, is not owned by `atlas_app`, and has
 *            no permissive policy and no DELETE policy
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyStudent,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedEnrollment,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { PrismaService } from '../src/database/prisma.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { PlatformOwnerAlertService } from '../src/communications/services/platform-owner-alert.service';
import { CommunicationsProcessor } from '../src/communications/queue/communications.processor';
import { CommunicationsScheduler } from '../src/communications/queue/communications.scheduler';

jest.setTimeout(240000);

class InertCommunicationsProcessor {}
class InertCommunicationsScheduler {}

const PASSWORD = 'correct-horse-battery-priv';

describe('B0-SEC-13 privacy requests (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let appPrisma: PrismaService;
  let tenancy: TenancyContextService;
  let flush: () => Promise<void>;
  let platformOwner: { userId: string; token: string };
  let owner: { userId: string; email: string; token: string };
  let academy: { id: string; organizationId: string };
  let host: string;

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function signUp(label: string) {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const user = await admin.user.update({
      where: { email },
      data: { emailVerifiedAt: new Date() },
    });
    const signIn = await http()
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return { email, userId: user.id, token: signIn.body.accessToken as string };
  }

  /** An Academy-surface session (password, then the emailed code when asked). */
  async function academySession(email: string) {
    const open = await http()
      .post('/auth/sign-in')
      .set('Host', host)
      .send({ email, password: PASSWORD, surface: 'academy', academyId: academy.id })
      .expect(200);
    if (open.body.accessToken) return open.body.accessToken as string;
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    const rows = await admin.$queryRaw<{ values: { code?: string } | null }[]>`
      SELECT "values" FROM "communication_outbox"
      WHERE "recipient_user_id" = ${user.id} AND "key" = 'auth.email.otp'
      ORDER BY "created_at" DESC LIMIT 1
    `;
    const verified = await http()
      .post('/auth/otp/verify')
      .set('Host', host)
      .send({
        challengeId: open.body.challengeId,
        code: rows[0]?.values?.code,
        rememberDevice: false,
        surface: 'academy',
      })
      .expect(200);
    return verified.body.accessToken as string;
  }

  async function learner(label: string) {
    const account = await signUp(label);
    await seedAcademyStudent(admin, academy.id, account.userId);
    return { ...account, siteToken: await academySession(account.email) };
  }

  async function privacyCode(token: string) {
    // Step past the 60-second resend cooldown of any earlier code of this
    // account (the cooldown itself is covered by account-deletion-otp).
    const me = await http().get('/users/me').set(bearer(token)).expect(200);
    await admin.accountDeletionChallenge.updateMany({
      where: { userId: me.body.id as string },
      data: { createdAt: new Date(Date.now() - 2 * 60 * 1000) },
    });
    const res = await http()
      .post('/privacy-requests/code')
      .set(bearer(token))
      .expect(200);
    const row = await admin.communicationOutbox.findFirstOrThrow({
      where: { key: 'auth.account.privacy_request_code', entityId: res.body.challengeId },
    });
    return {
      challengeId: res.body.challengeId as string,
      code: (row.values as { code: string }).code,
    };
  }

  async function file(token: string, type: 'deletion' | 'export') {
    const { challengeId, code } = await privacyCode(token);
    await flush();
    const res = await http()
      .post('/privacy-requests')
      .set(bearer(token))
      .send({ type, challengeId, code })
      .expect(200);
    return res.body as { id: string; status: string; type: string; canDownload: boolean };
  }

  const fulfil = (id: string) =>
    http()
      .post(`/platform-privacy-requests/${id}/fulfil`)
      .set(bearer(platformOwner.token))
      .send({ confirm: true });

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
    tenancy = app.get(TenancyContextService);
    await flush();

    const po = await signUp('priv-po');
    await admin.user.update({
      where: { id: po.userId },
      data: { isPlatformOwner: true },
    });
    platformOwner = { userId: po.userId, token: po.token };

    owner = await signUp('priv-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'priv-org');
    await seedActiveSubscriptionForOrg(admin, org.id, 'priv');
    const seeded = await seedAcademy(admin, org.id, 'priv-academy');
    await admin.academy.update({ where: { id: seeded.id }, data: { status: 'active' } });
    academy = { id: seeded.id, organizationId: org.id };
    host = `priv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.priv.test`;
    await admin.domainConnection.create({
      data: { academyId: academy.id, hostname: host, status: 'connected' },
    });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
  });

  it('PRIV-01 — files from an academy session only with a fresh emailed code; a retry returns the open request', async () => {
    const l = await learner('priv01');

    // No code, a wrong code: nothing is filed.
    await http()
      .post('/privacy-requests')
      .set(bearer(l.siteToken))
      .send({ type: 'export' })
      .expect(400);
    const { challengeId, code } = await privacyCode(l.siteToken);
    await flush();
    const wrong = code === '000000' ? '111111' : '000000';
    const refused = await http()
      .post('/privacy-requests')
      .set(bearer(l.siteToken))
      .send({ type: 'export', challengeId, code: wrong })
      .expect(401);
    expect(refused.body.error.messageKey).toBe('errors.account.deletionCodeInvalid');
    expect(await admin.privacyRequest.count({ where: { userId: l.userId } })).toBe(0);

    await flush();
    const filed = await http()
      .post('/privacy-requests')
      .set(bearer(l.siteToken))
      .send({ type: 'export', challengeId, code })
      .expect(200);
    expect(filed.body).toMatchObject({
      type: 'export',
      status: 'submitted',
      canDownload: false,
    });

    const row = await admin.privacyRequest.findUniqueOrThrow({
      where: { id: filed.body.id },
    });
    expect(row).toMatchObject({
      userId: l.userId,
      academyId: academy.id,
      requesterEmail: l.email,
    });

    // The code was single-use.
    await flush();
    await http()
      .post('/privacy-requests')
      .set(bearer(l.siteToken))
      .send({ type: 'export', challengeId, code })
      .expect(401);

    // A second request of the same type returns the open one.
    const again = await file(l.siteToken, 'export');
    expect(again.id).toBe(filed.body.id);
    expect(await admin.privacyRequest.count({ where: { userId: l.userId } })).toBe(1);

    const receipts = await admin.communicationOutbox.findMany({
      where: { key: 'privacy_request.received', entityId: row.id },
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      recipientUserId: l.userId,
      organizationId: null,
      academyId: academy.id,
    });

    const audit = await admin.auditLogEntry.findMany({
      where: { targetId: row.id, action: 'privacy_request.submitted' },
    });
    expect(audit).toHaveLength(1);
    const codeAudit = await admin.auditLogEntry.count({
      where: { actorUserId: l.userId, action: 'privacy_request.code.confirmed' },
    });
    // Two codes were confirmed: the first filing and the retry.
    expect(codeAudit).toBe(2);

    const mine = await http()
      .get('/privacy-requests/mine')
      .set(bearer(l.siteToken))
      .expect(200);
    expect(mine.body.map((r: { id: string }) => r.id)).toEqual([row.id]);
  });

  it('PRIV-02 — a code is accepted only for the purpose it was issued for', async () => {
    const a = await signUp('priv02');

    // An account-deletion code cannot file a privacy request…
    const del = await http()
      .post('/users/me/delete/request')
      .set(bearer(a.token))
      .expect(200);
    const delRow = await admin.communicationOutbox.findFirstOrThrow({
      where: { key: 'auth.account.deletion_code', entityId: del.body.challengeId },
    });
    await flush();
    await http()
      .post('/privacy-requests')
      .set(bearer(a.token))
      .send({
        type: 'deletion',
        challengeId: del.body.challengeId,
        code: (delRow.values as { code: string }).code,
      })
      .expect(401);
    expect(await admin.privacyRequest.count({ where: { userId: a.userId } })).toBe(0);

    // …and a privacy-request code cannot delete the account.
    await flush();
    const priv = await privacyCode(a.token);
    await flush();
    await http()
      .post('/users/me/delete')
      .set(bearer(a.token))
      .send({ confirm: true, challengeId: priv.challengeId, code: priv.code })
      .expect(401);
    expect((await admin.user.findUniqueOrThrow({ where: { id: a.userId } })).status).toBe(
      'active',
    );

    // Issuing a privacy code did not retire the open deletion code.
    await flush();
    await http()
      .post('/users/me/delete')
      .set(bearer(a.token))
      .send({
        confirm: true,
        challengeId: del.body.challengeId,
        code: (delRow.values as { code: string }).code,
        reason: 'other',
      })
      .expect(200);
  });

  it('PRIV-03 — only the requester and Platform Owners can read a request', async () => {
    const l = await learner('priv03');
    const filed = await file(l.siteToken, 'deletion');
    const other = await learner('priv03-other');

    const otherMine = await http()
      .get('/privacy-requests/mine')
      .set(bearer(other.siteToken))
      .expect(200);
    expect(otherMine.body).toEqual([]);

    // The academy's owner: not through the queue, and not through RLS.
    await http().get('/platform-privacy-requests').set(bearer(owner.token)).expect(403);
    const tenantView = await tenancy.runInTenantAndUserContext(
      academy.organizationId,
      owner.userId,
      (tx) => tx.privacyRequest.count({ where: { id: filed.id } }),
    );
    expect(tenantView).toBe(0);
    const otherView = await tenancy.runInUserContext(other.userId, (tx) =>
      tx.privacyRequest.count({ where: { id: filed.id } }),
    );
    expect(otherView).toBe(0);
    // A connection with no context at all sees nothing.
    expect(await appPrisma.privacyRequest.count({ where: { id: filed.id } })).toBe(0);
    // The requester cannot change their own request's status.
    const selfUpdate = await tenancy.runInUserContext(l.userId, (tx) =>
      tx.privacyRequest.updateMany({
        where: { id: filed.id },
        data: { status: 'completed' },
      }),
    );
    expect(selfUpdate.count).toBe(0);

    const queue = await http()
      .get('/platform-privacy-requests?status=submitted&type=deletion&pageSize=100')
      .set(bearer(platformOwner.token))
      .expect(200);
    const listed = queue.body.items.find((r: { id: string }) => r.id === filed.id);
    expect(listed).toMatchObject({
      userId: l.userId,
      academyName: expect.any(String),
      status: 'submitted',
    });
  });

  it('PRIV-04 — the export holds only the requester’s data, only once fulfilled, and expires', async () => {
    const l = await learner('priv04');
    const other = await learner('priv04-other');
    const course = await seedCourse(admin, academy.id, 'priv04-course', {
      status: 'published',
    });
    const otherCourse = await seedCourse(admin, academy.id, 'priv04-other-course', {
      status: 'published',
    });
    await seedEnrollment(admin, l.userId, course.id, academy.id);
    await seedEnrollment(admin, other.userId, otherCourse.id, academy.id);

    const filed = await file(l.siteToken, 'export');
    const download = () =>
      http().get(`/privacy-requests/mine/${filed.id}/export`).set(bearer(l.siteToken));
    await download().expect(404);

    const done = await fulfil(filed.id).expect(200);
    expect(done.body).toMatchObject({
      status: 'completed',
      exportAvailableUntil: expect.any(String),
    });
    const ready = await admin.communicationOutbox.findFirstOrThrow({
      where: { key: 'privacy_request.export_ready', entityId: filed.id },
    });
    expect(ready.recipientUserId).toBe(l.userId);

    const res = await download().expect(200);
    expect(res.headers['cache-control']).toContain('no-store');
    const bundle = res.body as {
      format: string;
      account: { id: string; email: string };
      enrollments: { courseId: string; courseTitle: string | null }[];
      academies: { academyId: string }[];
    };
    expect(bundle.format).toBe('atlas-personal-data-export');
    expect(bundle.account).toMatchObject({ id: l.userId, email: l.email });
    expect(bundle.enrollments.map((e) => e.courseId)).toEqual([course.id]);
    expect(bundle.enrollments[0].courseTitle).toEqual(expect.any(String));
    expect(bundle.academies.map((a) => a.academyId)).toEqual([academy.id]);
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain(other.userId);
    expect(serialized).not.toContain(other.email);
    expect(serialized).not.toContain(otherCourse.id);
    expect(serialized).not.toMatch(/passwordHash|secret|codeHash/i);

    const downloaded = await admin.auditLogEntry.count({
      where: { targetId: filed.id, action: 'privacy_request.export_downloaded' },
    });
    expect(downloaded).toBe(1);

    // Nobody else can fetch it — not another learner, not the Platform Owner here.
    await http()
      .get(`/privacy-requests/mine/${filed.id}/export`)
      .set(bearer(other.siteToken))
      .expect(404);
    await http()
      .get(`/privacy-requests/mine/${filed.id}/export`)
      .set(bearer(platformOwner.token))
      .expect(404);

    // Once the window closes, the same 404.
    await admin.privacyRequest.update({
      where: { id: filed.id },
      data: { exportAvailableUntil: new Date(Date.now() - 1000) },
    });
    await download().expect(404);
    const mine = await http()
      .get('/privacy-requests/mine')
      .set(bearer(l.siteToken))
      .expect(200);
    expect(mine.body[0]).toMatchObject({
      id: filed.id,
      status: 'completed',
      canDownload: false,
    });

    // A fulfilled request cannot be fulfilled twice.
    await fulfil(filed.id).expect(409);
  });

  it('PRIV-05 — deletion runs the existing Platform Owner path, audited, with the address masked', async () => {
    const l = await learner('priv05');
    const filed = await file(l.siteToken, 'deletion');

    const started = await http()
      .post(`/platform-privacy-requests/${filed.id}/status`)
      .set(bearer(platformOwner.token))
      .send({ status: 'in_progress' })
      .expect(200);
    expect(started.body.status).toBe('in_progress');

    // `confirm` is required.
    await http()
      .post(`/platform-privacy-requests/${filed.id}/fulfil`)
      .set(bearer(platformOwner.token))
      .send({})
      .expect(400);
    expect((await admin.user.findUniqueOrThrow({ where: { id: l.userId } })).status).toBe(
      'active',
    );

    const done = await fulfil(filed.id).expect(200);
    expect(done.body.status).toBe('completed');
    expect(done.body.requesterEmail).not.toBe(l.email);
    expect(done.body.requesterEmail).toContain('•••');

    const user = await admin.user.findUniqueOrThrow({ where: { id: l.userId } });
    expect(user.status).toBe('deleted');
    expect(
      await admin.auditLogEntry.count({
        where: { targetId: l.userId, action: 'account.deleted_by_platform_owner' },
      }),
    ).toBe(1);
    expect(
      await admin.auditLogEntry.count({
        where: {
          targetId: filed.id,
          action: 'privacy_request.fulfilled',
          actorUserId: platformOwner.userId,
        },
      }),
    ).toBe(1);

    const goodbye = await admin.communicationOutbox.findFirstOrThrow({
      where: { key: 'privacy_request.deletion_completed', entityId: filed.id },
    });
    expect(goodbye.recipientUserId).toBeNull();
    expect(goodbye.recipientEmail).toBe(l.email.toLowerCase());

    // The deleted person's session no longer works.
    await http().get('/privacy-requests/mine').set(bearer(l.siteToken)).expect(401);
  });

  it('PRIV-06 — declining needs a reason, which the person is emailed and sees', async () => {
    const l = await learner('priv06');
    const filed = await file(l.siteToken, 'deletion');

    await http()
      .post(`/platform-privacy-requests/${filed.id}/status`)
      .set(bearer(platformOwner.token))
      .send({ status: 'rejected' })
      .expect(400);
    await http()
      .post(`/platform-privacy-requests/${filed.id}/status`)
      .set(bearer(platformOwner.token))
      .send({
        status: 'rejected',
        note: 'An open payment dispute must be settled first.',
      })
      .expect(200);
    // Final: no further moves, no fulfilment.
    await http()
      .post(`/platform-privacy-requests/${filed.id}/status`)
      .set(bearer(platformOwner.token))
      .send({ status: 'in_progress' })
      .expect(409);
    await fulfil(filed.id).expect(409);

    const mine = await http()
      .get('/privacy-requests/mine')
      .set(bearer(l.siteToken))
      .expect(200);
    expect(mine.body[0]).toMatchObject({
      status: 'rejected',
      resolutionNote: 'An open payment dispute must be settled first.',
    });
    const email = await admin.communicationOutbox.findFirstOrThrow({
      where: { key: 'privacy_request.rejected', entityId: filed.id },
    });
    expect(email.recipientUserId).toBe(l.userId);
    expect((await admin.user.findUniqueOrThrow({ where: { id: l.userId } })).status).toBe(
      'active',
    );

    // After a decision a new request may be filed.
    const second = await file(l.siteToken, 'deletion');
    expect(second.id).not.toBe(filed.id);
  });

  it('PRIV-07 — every active Platform Owner is alerted, with no personal data', async () => {
    const l = await learner('priv07');
    const filed = await file(l.siteToken, 'export');
    await app.get(PlatformOwnerAlertService).drain();
    const alerts = await admin.communicationOutbox.findMany({
      where: { key: 'platform.privacy_request.created', entityId: filed.id },
    });
    expect(alerts.map((a) => a.recipientUserId)).toContain(platformOwner.userId);
    for (const alert of alerts) {
      const serialized = JSON.stringify(alert.values);
      expect(serialized).not.toContain(l.email);
      expect(serialized).toContain('export');
    }
  });

  it('PRIV-08 — FORCE RLS, not owned by the app role, no permissive or DELETE policy', async () => {
    const [table] = await admin.$queryRaw<
      { owner: string; rls: boolean; force: boolean }[]
    >`
      SELECT pg_get_userbyid(c.relowner) AS owner,
             c.relrowsecurity AS rls, c.relforcerowsecurity AS force
        FROM pg_class c
       WHERE c.relname = 'privacy_requests' AND c.relkind = 'r'`;
    expect(table).toMatchObject({ rls: true, force: true });
    expect(table.owner).not.toBe('atlas_app');
    const policies = await admin.$queryRaw<
      {
        policyname: string;
        cmd: string;
        qual: string | null;
        with_check: string | null;
      }[]
    >`
      SELECT policyname, cmd, qual, with_check FROM pg_policies
       WHERE tablename = 'privacy_requests'`;
    expect(policies.map((p) => p.policyname).sort()).toEqual([
      'privacy_requests_platform_select',
      'privacy_requests_platform_update',
      'privacy_requests_self_insert',
      'privacy_requests_self_select',
    ]);
    for (const policy of policies) {
      expect(policy.qual).not.toBe('true');
      expect(policy.with_check).not.toBe('true');
      expect(policy.cmd).not.toBe('DELETE');
    }
  });
});
