/**
 * W3-compose — Platform Owner "Compose and send" and academy "Messages",
 * end to end against real Postgres (FORCE RLS), Redis and the real queues.
 *
 * Pinned here:
 *   - AUTHORIZATION MATRIX: academy owner and administrator may preview and
 *     send; manager, instructor, staff, another academy's owner and a
 *     learner get 403; an INACTIVE owner membership and an inactive academy
 *     are refused; only the Platform Owner reaches the platform composer.
 *   - PREVIEW counts and exclusions (opted out, suppressed, blocked,
 *     pending) with the quota, and no side effects.
 *   - 409 when the audience moved since the preview.
 *   - QUOTA boundary: 422 ACADEMY_EMAIL_QUOTA_EXCEEDED with the remaining
 *     count, nothing created and nothing charged; and CONCURRENCY: parallel
 *     sends near the limit can never exceed it.
 *   - IDEMPOTENCY replay: same key → same campaign, charged once.
 *   - The worker expands, releases into the outbox (campaign_id), writes
 *     the in-app rows, sends with List-Unsubscribe (stub provider — local
 *     evidence, never a real delivery), and completes from real states.
 *   - UNSUBSCRIBE: the signed one-click POST opts the person out, and the
 *     next preview counts them as an exclusion.
 *   - SANITIZER at the API boundary.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedCourse,
  seedEnrollment,
  seedOrganizationWithOwner,
  seedPlan,
  seedTenantSubscription,
} from './utils/db-admin';
import { hashEmail } from '../src/communications/services/suppression.service';
import { CampaignWorkerService } from '../src/communications/campaigns/campaign-worker.service';
import { LinkBuilderService } from '../src/communications/services/link-builder.service';
import { StubEmailProvider } from '../src/identity/services/stub-email.provider';

jest.setTimeout(180_000);

const PASSWORD = 'correct-horse-battery';
const BODY =
  '<p>Hello <strong>class</strong></p><script>alert(1)</script><img src="https://t.example/p.gif">';

describe('W3-compose — campaigns (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let worker: CampaignWorkerService;
  let links: LinkBuilderService;
  let stub: StubEmailProvider;

  let platformOwner: Account;
  let owner: Account;
  let administrator: Account;
  let manager: Account;
  let instructor: Account;
  let staff: Account;
  let learner: Account;
  let otherOwner: Account;
  let inactiveOwner: Account;

  let organizationId: string;
  let academyId: string;
  let otherAcademyId: string;
  let otherCourseId: string;
  let courseId: string;
  const learnerIds: string[] = [];
  let optedOutId: string;

  interface Account {
    readonly email: string;
    readonly userId: string;
    readonly token: string;
  }

  async function signUp(label: string): Promise<Account> {
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return { email, userId: signIn.body.user.id, token: signIn.body.accessToken };
  }

  async function seedUser(label: string, preferences: object = {}) {
    const id = randomUUID();
    await admin.user.create({
      data: {
        id,
        email: `w3c-${label}-${randomUUID()}@example.test`,
        name: label,
        preferences,
      },
    });
    return id;
  }

  const server = () => app.getHttpServer();
  const learners = {
    audience: { type: 'learners' },
    channels: { email: true, inApp: true },
  };

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    flush = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
    worker = app.get(CampaignWorkerService);
    links = app.get(LinkBuilderService);
    stub = app.get(StubEmailProvider);

    platformOwner = await signUp('w3c-po');
    await admin.user.update({
      where: { id: platformOwner.userId },
      data: { isPlatformOwner: true },
    });

    owner = await signUp('w3c-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'w3c-org');
    organizationId = org.id;
    const plan = await seedPlan(admin, 'w3c-plan', {
      limits: {
        academies: 10,
        students: 1000,
        instructors: 50,
        staff: 50,
        courses: 50,
        generalStorage: 10,
        videoStorage: 10,
        monthlyEmails: 6,
      },
    });
    await seedTenantSubscription(admin, org.id, plan.id, { status: 'active' });
    const academy = await seedAcademy(admin, org.id, 'w3c-academy');
    academyId = academy.id;
    await admin.academy.update({ where: { id: academyId }, data: { status: 'active' } });
    await seedAcademyMember(admin, academyId, owner.userId, 'owner');

    administrator = await signUp('w3c-admin');
    manager = await signUp('w3c-manager');
    instructor = await signUp('w3c-instructor');
    staff = await signUp('w3c-staff');
    inactiveOwner = await signUp('w3c-inactive');
    for (const [account, role] of [
      [administrator, 'administrator'],
      [manager, 'manager'],
      [instructor, 'instructor'],
      [staff, 'staff'],
      [inactiveOwner, 'owner'],
    ] as const) {
      // Organization members too, so AcademyScopeGuard admits them and the
      // refusal under test is the academy-role check, not the guard.
      await admin.organizationMembership.create({
        data: { organizationId, userId: account.userId, role: 'member' },
      });
      await seedAcademyMember(admin, academyId, account.userId, role);
    }
    await admin.academyMember.updateMany({
      where: { academyId, userId: inactiveOwner.userId },
      data: { status: 'inactive' },
    });

    learner = await signUp('w3c-learner');
    await admin.academyStudent.create({ data: { academyId, userId: learner.userId } });
    learnerIds.push(learner.userId);
    for (const label of ['l1', 'l2']) {
      const id = await seedUser(label);
      learnerIds.push(id);
      await admin.academyStudent.create({ data: { academyId, userId: id } });
    }
    optedOutId = await seedUser('optout', {
      notifications: { categories: { engagement: { email: false } } },
    });
    await admin.academyStudent.create({ data: { academyId, userId: optedOutId } });
    const suppressedId = await seedUser('suppressed');
    await admin.academyStudent.create({ data: { academyId, userId: suppressedId } });
    const suppressedUser = await admin.user.findUniqueOrThrow({
      where: { id: suppressedId },
    });
    await admin.communicationSuppression.create({
      data: {
        emailHash: hashEmail(suppressedUser.email),
        reason: 'hard_bounce',
        source: 'test',
      },
    });
    const blockedId = await seedUser('blocked');
    await admin.academyStudent.create({
      data: { academyId, userId: blockedId, blockedAt: new Date() },
    });
    const pendingId = await seedUser('pending');
    await admin.academyStudent.create({
      data: { academyId, userId: pendingId, status: 'pending' },
    });

    const course = await seedCourse(admin, academyId, 'w3c-course');
    courseId = course.id;
    await seedEnrollment(admin, learnerIds[1], courseId, academyId);

    otherOwner = await signUp('w3c-other');
    const otherOrg = await seedOrganizationWithOwner(
      admin,
      otherOwner.userId,
      'w3c-other',
    );
    await seedTenantSubscription(admin, otherOrg.id, plan.id, { status: 'active' });
    const otherAcademy = await seedAcademy(admin, otherOrg.id, 'w3c-other-academy');
    otherAcademyId = otherAcademy.id;
    await admin.academy.update({
      where: { id: otherAcademyId },
      data: { status: 'active' },
    });
    await seedAcademyMember(admin, otherAcademyId, otherOwner.userId, 'owner');
    otherCourseId = (await seedCourse(admin, otherAcademyId, 'w3c-other-course')).id;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
  });

  function send(account: Account, body: Record<string, unknown>, academy = academyId) {
    return request(server())
      .post(`/academies/${academy}/messages`)
      .set('Authorization', `Bearer ${account.token}`)
      .send({
        idempotencyKey: randomUUID(),
        subject: 'Class update',
        bodyHtml: BODY,
        ...learners,
        ...body,
      });
  }

  async function usage(academy = academyId): Promise<number> {
    const rows = await admin.tenantEmailUsagePeriod.findMany({
      where: { academyId: academy },
    });
    return rows.reduce((sum, row) => sum + row.used, 0);
  }

  // ------------------------------------------------------------------ auth

  describe('authorization matrix', () => {
    it.each([
      ['owner', () => owner],
      ['administrator', () => administrator],
    ])('%s may preview', async (_label, who) => {
      const res = await request(server())
        .post(`/academies/${academyId}/messages/preview`)
        .set('Authorization', `Bearer ${who().token}`)
        .send(learners)
        .expect(200);
      expect(res.body.recipientCount).toBe(5);
    });

    it.each([
      ['manager', () => manager],
      ['instructor', () => instructor],
      ['staff', () => staff],
      ['an inactive owner membership', () => inactiveOwner],
      ['another academy’s owner', () => otherOwner],
      ['a learner', () => learner],
    ])('%s is refused (403) on preview, send, history and quota', async (_label, who) => {
      const token = who().token;
      await request(server())
        .post(`/academies/${academyId}/messages/preview`)
        .set('Authorization', `Bearer ${token}`)
        .send(learners)
        .expect(403);
      await send(who(), { expectedRecipientCount: 5 }).expect(403);
      await request(server())
        .get(`/academies/${academyId}/messages`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      await request(server())
        .get(`/academies/${academyId}/messages/quota`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('refuses an academy that is not active', async () => {
      await admin.academy.update({
        where: { id: academyId },
        data: { status: 'suspended' },
      });
      try {
        await request(server())
          .post(`/academies/${academyId}/messages/preview`)
          .set('Authorization', `Bearer ${owner.token}`)
          .send(learners)
          .expect(403);
      } finally {
        await admin.academy.update({
          where: { id: academyId },
          data: { status: 'active' },
        });
      }
    });

    it('keeps the platform composer to the Platform Owner', async () => {
      const body = {
        audience: { type: 'org_owners' },
        channels: { email: true, inApp: false },
      };
      await request(server())
        .post('/platform-communications/campaigns/preview')
        .set('Authorization', `Bearer ${owner.token}`)
        .send(body)
        .expect(403);
      await request(server())
        .post('/platform-communications/campaigns/preview')
        .set('Authorization', `Bearer ${platformOwner.token}`)
        .send(body)
        .expect(200);
      await request(server())
        .post('/platform-communications/campaigns/preview')
        .send(body)
        .expect(401);
    });

    it('refuses a course of another academy (tenant isolation)', async () => {
      const res = await request(server())
        .post(`/academies/${academyId}/messages/preview`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          audience: { type: 'courses', courseIds: [otherCourseId] },
          channels: learners.channels,
        })
        .expect(422);
      expect(res.body.error.code).toBe('CAMPAIGN_UNKNOWN_COURSE');
    });

    it('rejects a malformed audience (unknown keys, user ids from the client)', async () => {
      await request(server())
        .post(`/academies/${academyId}/messages/preview`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          audience: { type: 'learners', userIds: [owner.userId] },
          channels: learners.channels,
        })
        .expect(400);
    });
  });

  // --------------------------------------------------------------- preview

  describe('preview', () => {
    it('counts recipients, exclusions and quota without side effects', async () => {
      const before = await admin.communicationCampaign.count({ where: { academyId } });
      const res = await request(server())
        .post(`/academies/${academyId}/messages/preview`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send(learners)
        .expect(200);
      expect(res.body).toMatchObject({
        recipientCount: 5,
        emailCount: 3,
        inAppCount: 5,
        excluded: { optedOut: 1, suppressed: 1, blocked: 1, pending: 1 },
        requiresConfirmation: false,
        quota: { limit: 6, used: 0, remaining: 6 },
        overBy: 0,
      });
      expect(new Date(res.body.quota.resetsAt).getUTCDate()).toBe(1);
      expect(await admin.communicationCampaign.count({ where: { academyId } })).toBe(
        before,
      );
      expect(await usage()).toBe(0);
    });

    it('narrows to a course audience inside the academy', async () => {
      const res = await request(server())
        .post(`/academies/${academyId}/messages/preview`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          audience: { type: 'courses', courseIds: [courseId] },
          channels: learners.channels,
        })
        .expect(200);
      expect(res.body.recipientCount).toBe(1);
    });
  });

  // ------------------------------------------------------------- send flow

  describe('send', () => {
    let firstCampaignId: string;
    const key = randomUUID();

    it('returns 409 when the audience changed since the preview', async () => {
      const res = await send(owner, { expectedRecipientCount: 4 }).expect(409);
      expect(res.body.error.code).toBe('CAMPAIGN_AUDIENCE_CHANGED');
      expect(res.body.error.details.recipientCount).toBe(5);
      expect(await usage()).toBe(0);
    });

    it('accepts (202), charges the email count and sanitises the body', async () => {
      const res = await send(owner, {
        idempotencyKey: key,
        expectedRecipientCount: 5,
      }).expect(202);
      expect(res.body).toMatchObject({
        recipientCount: 5,
        emailCount: 3,
        inAppCount: 5,
        replayed: false,
        quota: { limit: 6, used: 3, remaining: 3 },
      });
      firstCampaignId = res.body.campaignId;
      const stored = await admin.communicationCampaign.findUniqueOrThrow({
        where: { id: firstCampaignId },
      });
      expect(stored.bodyHtml).toBe('<p>Hello <strong>class</strong></p>');
      expect(stored.bodyHtml).not.toMatch(/script|img/);
      expect(await usage()).toBe(3);
      const ledger = await admin.tenantEmailUsageLedger.findMany({
        where: { messageId: firstCampaignId },
      });
      expect(ledger).toEqual([expect.objectContaining({ kind: 'charge', quantity: 3 })]);
      const audit = await admin.auditLogEntry.findFirst({
        where: { action: 'academy.message.sent', targetId: firstCampaignId },
      });
      expect(audit).not.toBeNull();
    });

    it('replays the same idempotency key without charging again', async () => {
      const res = await send(owner, {
        idempotencyKey: key,
        expectedRecipientCount: 5,
      }).expect(202);
      expect(res.body.campaignId).toBe(firstCampaignId);
      expect(res.body.replayed).toBe(true);
      expect(await usage()).toBe(3);
      expect(
        await admin.communicationCampaign.count({ where: { idempotencyKey: key } }),
      ).toBe(1);
    });

    it('refuses with 422 and the remaining count when emails exceed the quota — nothing sent or charged', async () => {
      // 3 used of 6; the learners audience needs 3 → fits exactly once more…
      await send(owner, { expectedRecipientCount: 5 }).expect(202);
      expect(await usage()).toBe(6);
      const before = await admin.communicationCampaign.count({ where: { academyId } });
      const res = await send(owner, { expectedRecipientCount: 5 }).expect(422);
      expect(res.body.error.code).toBe('ACADEMY_EMAIL_QUOTA_EXCEEDED');
      expect(res.body.error.details).toMatchObject({ remaining: 0, requested: 3 });
      expect(await admin.communicationCampaign.count({ where: { academyId } })).toBe(
        before,
      );
      expect(await usage()).toBe(6);
      // In-app only is never counted, so it still goes through.
      await send(owner, {
        channels: { email: false, inApp: true },
        expectedRecipientCount: 5,
      }).expect(202);
      expect(await usage()).toBe(6);
    });

    it('expands, releases and completes from real outbox states (stub provider evidence)', async () => {
      const deadline = Date.now() + 90_000;
      let outcome = '';
      while (Date.now() < deadline) {
        outcome = await worker.run(firstCampaignId);
        if (outcome === 'completed') break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(outcome).toBe('completed');

      const outbox = await admin.communicationOutbox.findMany({
        where: { campaignId: firstCampaignId },
      });
      expect(outbox).toHaveLength(3);
      expect(new Set(outbox.map((row) => row.recipientUserId))).toEqual(
        new Set([learner.userId, learnerIds[1], learnerIds[2]]),
      );
      for (const row of outbox) {
        expect(row.academyId).toBe(academyId);
        expect(row.organizationId).toBe(organizationId);
        expect(row.key).toBe('academy.message.sent');
        expect(['dispatched', 'suppressed', 'failed']).toContain(row.state);
      }
      const recipients = await admin.campaignRecipient.findMany({
        where: { campaignId: firstCampaignId },
      });
      expect(recipients).toHaveLength(5);
      expect(recipients.find((r) => r.userId === optedOutId)).toMatchObject({
        emailEligible: false,
        exclusion: 'opted_out',
      });
      const notifications = await admin.notification.count({
        where: { dedupeKey: `campaign:${firstCampaignId}` },
      });
      expect(notifications).toBe(5);

      const campaign = await admin.communicationCampaign.findUniqueOrThrow({
        where: { id: firstCampaignId },
      });
      expect(campaign).toMatchObject({
        status: 'completed',
        emailReleasedCount: 3,
        inAppReleasedCount: 5,
        excludedOptedOut: 1,
        excludedSuppressed: 1,
      });

      // Local evidence only: the stub recorded the send with RFC 8058 headers.
      const learnerSend = stub
        .recordedSends()
        .find((input) => input.to === learner.email && input.subject === 'Class update');
      expect(learnerSend?.headers?.['List-Unsubscribe']).toMatch(
        /^<https?:\/\/.+\/api\/v1\/communications\/unsubscribe\?token=.+>$/,
      );
      expect(learnerSend?.headers?.['List-Unsubscribe-Post']).toBe(
        'List-Unsubscribe=One-Click',
      );
      expect(learnerSend?.html).toContain('<strong>class</strong>');

      const history = await request(server())
        .get(`/academies/${academyId}/messages`)
        .set('Authorization', `Bearer ${administrator.token}`)
        .expect(200);
      const item = history.body.items.find(
        (row: { id: string }) => row.id === firstCampaignId,
      );
      expect(item.status).toBe('completed');
      expect(item.progress.queued).toBe(0);
      expect(item.progress.sent + item.progress.skipped + item.progress.failed).toBe(3);
      expect(item.progress.inApp).toBe(5);
    });
  });

  // ----------------------------------------------------------- concurrency

  describe('quota concurrency', () => {
    it('parallel sends near the limit can never exceed it', async () => {
      const org = await seedOrganizationWithOwner(admin, owner.userId, 'w3c-race');
      const plan = await seedPlan(admin, 'w3c-race-plan', {
        limits: {
          academies: 10,
          students: 10,
          instructors: 10,
          staff: 10,
          courses: 10,
          generalStorage: 1,
          videoStorage: 1,
          monthlyEmails: 3,
        },
      });
      await seedTenantSubscription(admin, org.id, plan.id, { status: 'active' });
      const raceAcademy = await seedAcademy(admin, org.id, 'w3c-race-academy');
      await admin.academy.update({
        where: { id: raceAcademy.id },
        data: { status: 'active' },
      });
      await seedAcademyMember(admin, raceAcademy.id, owner.userId, 'owner');
      await seedAcademyMember(admin, raceAcademy.id, manager.userId, 'manager');

      const body = {
        audience: { type: 'staff', roles: ['manager'] },
        channels: { email: true, inApp: false },
        expectedRecipientCount: 1,
      };
      const results = await Promise.all(
        Array.from({ length: 6 }, () => send(owner, body, raceAcademy.id)),
      );
      const statuses = results.map((res) => res.status).sort();
      expect(statuses.filter((status) => status === 202)).toHaveLength(3);
      expect(statuses.filter((status) => status === 422)).toHaveLength(3);
      for (const res of results.filter((r) => r.status === 422)) {
        expect(res.body.error.code).toBe('ACADEMY_EMAIL_QUOTA_EXCEEDED');
      }
      const period = await admin.tenantEmailUsagePeriod.findFirstOrThrow({
        where: { academyId: raceAcademy.id },
      });
      expect(period.used).toBe(3);
      expect(period.used).toBeLessThanOrEqual(period.limitSnapshot!);
      expect(
        await admin.communicationCampaign.count({ where: { academyId: raceAcademy.id } }),
      ).toBe(3);
    });
  });

  // ------------------------------------------------------- settle / ledger

  describe('settle: charge = rows actually created; failures refunded', () => {
    it('gives back the unused reservation and refunds terminal failures, exactly once', async () => {
      const org = await seedOrganizationWithOwner(admin, owner.userId, 'w3c-settle');
      const settleAcademy = await seedAcademy(admin, org.id, 'w3c-settle-academy');
      const periodStart = new Date(
        Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
      );
      const periodEnd = new Date(
        Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1),
      );
      const campaignId = randomUUID();
      // A campaign that reserved 5, but whose release created only 2 email
      // rows (three people left between send and expansion); one of the
      // two then failed terminally without provider acceptance.
      await admin.communicationCampaign.create({
        data: {
          id: campaignId,
          scope: 'academy',
          organizationId: org.id,
          academyId: settleAcademy.id,
          createdBy: owner.userId,
          idempotencyScope: `academy:${settleAcademy.id}`,
          idempotencyKey: randomUUID(),
          key: 'academy.message.sent',
          channels: { email: true, inApp: false },
          audience: { type: 'learners' },
          subject: 'Settle',
          bodyHtml: '<p>x</p>',
          bodyText: 'x',
          status: 'sending',
          recipientCount: 5,
          expectedEmailCount: 5,
          emailReleasedCount: 2,
          quotaPeriodStart: periodStart,
          quotaReserved: 5,
        },
      });
      await admin.tenantEmailUsagePeriod.create({
        data: {
          academyId: settleAcademy.id,
          organizationId: org.id,
          periodStart,
          periodEnd,
          limitSnapshot: 50,
          used: 5,
        },
      });
      await admin.tenantEmailUsageLedger.create({
        data: {
          id: randomUUID(),
          organizationId: org.id,
          academyId: settleAcademy.id,
          periodStart,
          messageId: campaignId,
          kind: 'charge',
          quantity: 5,
        },
      });
      for (const state of ['dispatched', 'failed'] as const) {
        await admin.communicationOutbox.create({
          data: {
            id: randomUUID(),
            key: 'academy.message.sent',
            category: 'engagement',
            recipientUserId: await seedUser(`settle-${state}`),
            organizationId: org.id,
            academyId: settleAcademy.id,
            entityType: 'communication_campaign',
            entityId: campaignId,
            dedupeKey: `campaign:${campaignId}`,
            channels: { inApp: false, email: 'preference' },
            state,
            campaignId,
          },
        });
      }

      await expect(worker.run(campaignId)).resolves.toBe('completed');
      const ledger = await admin.tenantEmailUsageLedger.findMany({
        where: { messageId: campaignId },
        orderBy: { kind: 'asc' },
      });
      expect(ledger.map((row) => [row.kind, row.quantity])).toEqual([
        ['charge', 5],
        ['refund', 1],
        ['release', 3],
      ]);
      const period = await admin.tenantEmailUsagePeriod.findFirstOrThrow({
        where: { academyId: settleAcademy.id },
      });
      expect(period.used).toBe(1);

      // Re-running the settle (a retried job) moves nothing.
      await admin.communicationCampaign.update({
        where: { id: campaignId },
        data: { status: 'sending' },
      });
      await worker.run(campaignId);
      expect(
        (
          await admin.tenantEmailUsagePeriod.findFirstOrThrow({
            where: { academyId: settleAcademy.id },
          })
        ).used,
      ).toBe(1);
      expect(
        await admin.tenantEmailUsageLedger.count({ where: { messageId: campaignId } }),
      ).toBe(3);
    });
  });

  // ----------------------------------------------------------- unsubscribe

  describe('one-click unsubscribe', () => {
    it('opts the person out and the next preview counts them as excluded', async () => {
      const url = links.unsubscribe(learnerIds[1], 'engagement')!;
      const path = new URL(url).pathname.replace(/^\/api\/v1/, '') + new URL(url).search;

      // GET is a confirmation page and changes nothing.
      const page = await request(server()).get(path).expect(200);
      expect(page.text).toContain('<form method="post"');
      let user = await admin.user.findUniqueOrThrow({ where: { id: learnerIds[1] } });
      expect(JSON.stringify(user.preferences)).not.toContain('"email":false');

      await request(server())
        .post(path)
        .type('form')
        .send('List-Unsubscribe=One-Click')
        .expect(200);
      user = await admin.user.findUniqueOrThrow({ where: { id: learnerIds[1] } });
      expect(
        (
          user.preferences as {
            notifications: { categories: { engagement: { email: boolean } } };
          }
        ).notifications.categories.engagement.email,
      ).toBe(false);

      const res = await request(server())
        .post(`/academies/${academyId}/messages/preview`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send(learners)
        .expect(200);
      expect(res.body.excluded.optedOut).toBe(2);
      expect(res.body.emailCount).toBe(2);
    });

    it('rejects a forged token', async () => {
      await request(server())
        .post('/communications/unsubscribe?token=abc.def')
        .expect(400);
    });
  });

  // -------------------------------------------------------------- platform

  describe('platform campaigns', () => {
    it('previews, sends (202) and releases org-owner email without touching any quota', async () => {
      const audience = { type: 'organization', organizationId };
      const preview = await request(server())
        .post('/platform-communications/campaigns/preview')
        .set('Authorization', `Bearer ${platformOwner.token}`)
        .send({ audience, channels: { email: true, inApp: true } })
        .expect(200);
      // org members (owner + 5 seeded members) + academy owner/admins, de-duplicated.
      expect(preview.body.recipientCount).toBe(6);
      expect(preview.body.quota).toBeNull();

      const usedBefore = await usage();
      const res = await request(server())
        .post('/platform-communications/campaigns')
        .set('Authorization', `Bearer ${platformOwner.token}`)
        .send({
          idempotencyKey: randomUUID(),
          subject: 'Scheduled maintenance',
          bodyHtml: '<p>We will be offline on Sunday.</p>',
          audience,
          channels: { email: true, inApp: true },
          expectedRecipientCount: preview.body.recipientCount,
        })
        .expect(202);
      const campaignId = res.body.campaignId;

      const deadline = Date.now() + 90_000;
      let outcome = '';
      while (Date.now() < deadline) {
        outcome = await worker.run(campaignId);
        if (outcome === 'completed') break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(outcome).toBe('completed');
      const rows = await admin.communicationOutbox.findMany({ where: { campaignId } });
      expect(rows.length).toBe(preview.body.emailCount);
      expect(rows.every((row) => row.organizationId === null)).toBe(true);
      expect(await usage()).toBe(usedBefore);

      const list = await request(server())
        .get('/platform-communications/campaigns')
        .set('Authorization', `Bearer ${platformOwner.token}`)
        .expect(200);
      expect(list.body.items.some((item: { id: string }) => item.id === campaignId)).toBe(
        true,
      );
    });
  });
});
