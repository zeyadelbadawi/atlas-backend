/**
 * TASK 7 — the Atlas marketing homepage's contact form and the Platform
 * Owner's inbox for it, end to end against the real `AppModule`, real
 * Postgres with FORCE RLS and real Redis (throttler + dedupe).
 *
 * WHAT IS PROVEN
 *   - `POST public/contact` stores a real, normalized row (keyed IP hash,
 *     never the raw address) and notifies Platform Owners through the
 *     outbox, answering every accepted case with the same body;
 *   - honeypot and too-fast submissions are discarded silently (2xx,
 *     nothing stored), an identical repeat inside the window is stored
 *     once, and the 6th request from one IP in 10 minutes is a 429;
 *   - malformed input is a 400 (oversize, unknown properties,
 *     whitespace-only fields) and leaks nothing internal;
 *   - the inbox is Platform-Owner-only: a tenant user is refused, and an
 *     academy-website session is refused even for a Platform Owner;
 *   - list/detail/patch/delete work for the owner, and patch/delete write
 *     audit rows in the same transaction;
 *   - the visitor's details never reach the in-app feed, leave the outbox
 *     once the email is sent, and leave every outbox row of the enquiry
 *     when it is deleted (`personalValues`);
 *   - RLS itself refuses tenant and anonymous contexts.
 *
 * Every request carries its own `X-Real-IP` (honoured from a loopback
 * peer, exactly like production behind Caddy), so throttle buckets are
 * independent per case.
 *
 * Delivery is driven by the test, not by a background worker: the
 * communications producer, processor and scheduler are inert here, and
 * the case that needs a sent email hands its row to the real
 * `CommunicationDispatchService.dispatch` — same reasoning as
 * `email-verification-link-security.e2e-spec.ts`.
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
  seedActiveSubscriptionForOrg,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { PlatformContactIntakeService } from '../src/platform-contact/services/platform-contact-intake.service';
import { CommunicationsProcessor } from '../src/communications/queue/communications.processor';
import { CommunicationsProducer } from '../src/communications/queue/communications.producer';
import { CommunicationsScheduler } from '../src/communications/queue/communications.scheduler';
import { CommunicationDispatchService } from '../src/communications/services/communication-dispatch.service';
import { RedisService } from '../src/redis/redis.service';

jest.setTimeout(120000);

const PASSWORD = 'correct-horse-battery-contact';
const NOTIFICATION_KEY = 'platform.contact_submission.received';

class InertCommunicationsProcessor {}
class InertCommunicationsScheduler {}
class InertCommunicationsProducer {
  async enqueueDispatch(): Promise<boolean> {
    return true;
  }
}

let ipCounter = 0;
/** A fresh documentation-range address per call, so throttle buckets never collide. */
function freshIp(): string {
  ipCounter += 1;
  const salt = Math.floor(Math.random() * 200);
  return `198.18.${(salt + Math.floor(ipCounter / 250)) % 255}.${(ipCounter % 250) + 1}`;
}

describe('Platform contact submissions (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let tenancy: TenancyContextService;
  let intake: PlatformContactIntakeService;
  let dispatcher: CommunicationDispatchService;
  let redis: ReturnType<RedisService['getClient']>;
  let flushRateLimitKeys: () => Promise<void>;

  let ownerToken: string;
  let ownerUserId: string;
  let tenantToken: string;
  let tenantUserId: string;

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

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
    tenancy = app.get(TenancyContextService, { strict: false });
    intake = app.get(PlatformContactIntakeService, { strict: false });
    dispatcher = app.get(CommunicationDispatchService, { strict: false });
    redis = app.get(RedisService, { strict: false }).getClient();
    flushRateLimitKeys = testApp.flushRateLimitKeys;

    const owner = await seedPlatformOwner('contact-po');
    ownerToken = owner.token;
    ownerUserId = owner.userId;
    const tenant = await signUp('contact-tenant');
    tenantToken = tenant.token;
    tenantUserId = tenant.userId;
  });

  afterAll(async () => {
    // Let the queued owner notifications finish before the pool closes.
    await intake.drainNotifications();
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  async function signUp(label: string) {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const signIn = await http()
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      email,
      userId: signIn.body.user.id as string,
      token: signIn.body.accessToken as string,
    };
  }

  async function seedPlatformOwner(label: string) {
    const account = await signUp(label);
    await admin.user.update({
      where: { id: account.userId },
      data: { isPlatformOwner: true },
    });
    const signIn = await http()
      .post('/auth/sign-in')
      .send({ email: account.email, password: PASSWORD })
      .expect(200);
    return { ...account, token: signIn.body.accessToken as string };
  }

  /** A unique, valid enquiry. `startedAt` is comfortably past the minimum fill time. */
  function enquiry(overrides: Record<string, unknown> = {}) {
    const tag = randomUUID();
    return {
      name: 'Layla Haddad',
      email: `Lead-${tag}@Example.test`,
      organizationName: 'Falcon Learning',
      topic: 'sales',
      message: `We would like a walkthrough of Atlas for our three academies. Ref ${tag}`,
      locale: 'en',
      sourcePath: '/',
      startedAt: Date.now() - 30_000,
      ...overrides,
    };
  }

  function submit(body: Record<string, unknown>, ip = freshIp()) {
    return http().post('/public/contact').set('X-Real-IP', ip).send(body);
  }

  function rowsFor(email: string) {
    return admin.platformContactSubmission.findMany({
      where: { email: email.trim().toLowerCase() },
    });
  }

  /** Stores one enquiry through the real endpoint and returns its row. */
  async function storedEnquiry(overrides: Record<string, unknown> = {}) {
    const body = enquiry(overrides);
    await submit(body).expect(201);
    const [row] = await rowsFor(body.email as string);
    expect(row).toBeDefined();
    return row;
  }

  // ---------------------------------------------------------------------
  // Public intake
  // ---------------------------------------------------------------------

  describe('POST /public/contact', () => {
    it('stores a valid enquiry (normalized, hashed IP) and notifies platform owners', async () => {
      const ip = freshIp();
      const body = enquiry({ name: '  Layla Haddad  ', locale: 'ar' });
      const res = await submit(body, ip).expect(201);
      expect(res.body).toEqual({ received: true });

      const rows = await rowsFor(body.email as string);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row).toMatchObject({
        name: 'Layla Haddad',
        email: (body.email as string).toLowerCase(),
        organizationName: 'Falcon Learning',
        topic: 'sales',
        locale: 'ar',
        sourcePath: '/',
        status: 'new',
        readAt: null,
      });
      expect(row.ipHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toContain(ip);

      // In-app + outbox rows are written right after the enquiry commits,
      // off the request path; drain the fan-out before looking.
      await intake.drainNotifications();
      const outbox = await admin.communicationOutbox.findMany({
        where: { key: 'platform.contact_submission.received', entityId: row.id },
      });
      expect(outbox.length).toBeGreaterThan(0);
      const recipientIds = outbox
        .map((o) => o.recipientUserId)
        .filter((id): id is string => typeof id === 'string');
      expect(recipientIds).toHaveLength(outbox.length);
      expect(recipientIds).toContain(ownerUserId);
      const recipients = await admin.user.findMany({
        where: { id: { in: recipientIds } },
        select: { isPlatformOwner: true },
      });
      expect(recipients.every((u) => u.isPlatformOwner)).toBe(true);
      const notified = await admin.notification.findMany({
        where: {
          titleKey: 'notifications:events.platformContactSubmissionReceived.title',
          dedupeKey: `platform_contact_received:${row.id}`,
        },
      });
      expect(notified.length).toBe(outbox.length);
    });

    it('discards a honeypot hit: 201, same body, nothing stored', async () => {
      const body = enquiry({ company: 'Acme Spam Ltd' });
      const res = await submit(body).expect(201);
      expect(res.body).toEqual({ received: true });
      await expect(rowsFor(body.email as string)).resolves.toHaveLength(0);
    });

    it('discards a too-fast submission: 201, same body, nothing stored', async () => {
      const body = enquiry({ startedAt: Date.now() - 200 });
      const res = await submit(body).expect(201);
      expect(res.body).toEqual({ received: true });
      await expect(rowsFor(body.email as string)).resolves.toHaveLength(0);
    });

    it('stores an identical address + message only once inside the window', async () => {
      const body = enquiry();
      await submit(body).expect(201);
      // Different IP, different casing/whitespace — still the same enquiry.
      const again = await submit({
        ...body,
        email: ` ${(body.email as string).toUpperCase()} `,
        message: `  ${body.message as string}  `,
      }).expect(201);
      expect(again.body).toEqual({ received: true });
      await expect(rowsFor(body.email as string)).resolves.toHaveLength(1);
    });

    it('answers the 6th request from one IP in 10 minutes with 429', async () => {
      const ip = freshIp();
      for (let i = 0; i < 5; i += 1) {
        await submit(enquiry(), ip).expect(201);
      }
      const limited = await submit(enquiry(), ip);
      expect(limited.status).toBe(429);
      // A different address is not affected.
      await submit(enquiry()).expect(201);
    });

    it.each([
      ['an over-long name', { name: 'a'.repeat(201) }],
      ['an over-long organization', { organizationName: 'a'.repeat(201) }],
      ['an over-long message', { message: 'a'.repeat(5001) }],
      ['an over-long email', { email: `${'a'.repeat(310)}@example.test` }],
      ['an invalid email', { email: 'not-an-email' }],
      ['a whitespace-only name', { name: '     ' }],
      ['a whitespace-only message', { message: ' \n\t        ' }],
      ['an unknown topic', { topic: 'billing' }],
      ['an unknown property', { website: 'https://spam.test' }],
      ['a server-owned property', { status: 'read' }],
      ['a missing startedAt', { startedAt: undefined }],
    ])('rejects %s with 400 and stores nothing', async (_label, overrides) => {
      const body = enquiry(overrides);
      const res = await submit(body).expect(400);
      expect(JSON.stringify(res.body)).not.toMatch(/prisma|stack|sql|postgres/i);
      if (typeof body.email === 'string' && body.email.includes('@example.test')) {
        await expect(rowsFor(body.email)).resolves.toHaveLength(0);
      }
    });
  });

  // ---------------------------------------------------------------------
  // Authorization
  // ---------------------------------------------------------------------

  describe('authorization', () => {
    it('refuses an unauthenticated caller and a non-owner', async () => {
      await http().get('/platform/contact-submissions').expect(401);
      await http()
        .get('/platform/contact-submissions')
        .set(bearer(tenantToken))
        .expect(403);
      await http()
        .get('/platform/contact-submissions/summary')
        .set(bearer(tenantToken))
        .expect(403);
      const row = await storedEnquiry();
      await http()
        .patch(`/platform/contact-submissions/${row.id}`)
        .set(bearer(tenantToken))
        .send({ status: 'read' })
        .expect(403);
      await http()
        .delete(`/platform/contact-submissions/${row.id}`)
        .set(bearer(tenantToken))
        .expect(403);
      await expect(
        admin.platformContactSubmission.findUnique({ where: { id: row.id } }),
      ).resolves.toMatchObject({ status: 'new' });
    });

    it('refuses an academy-website session, even when its person is a Platform Owner', async () => {
      const staff = await signUp('contact-academy-owner');
      const org = await seedOrganizationWithOwner(
        admin,
        staff.userId,
        'contact-surface-org',
      );
      await seedActiveSubscriptionForOrg(admin, org.id);
      const academy = await seedAcademy(admin, org.id, 'contact-surface-academy');
      await admin.academy.update({
        where: { id: academy.id },
        data: { status: 'active', registrationPolicy: 'open' },
      });
      await seedAcademyMember(admin, academy.id, staff.userId, 'owner');
      const host = `contact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.contact.test`;
      await admin.domainConnection.create({
        data: { academyId: academy.id, hostname: host, status: 'connected' },
      });
      await admin.user.update({
        where: { id: staff.userId },
        data: { isPlatformOwner: true },
      });

      const academySignIn = await http()
        .post('/auth/sign-in')
        .set('Host', host)
        .send({
          email: staff.email,
          password: PASSWORD,
          surface: 'academy',
          academyId: academy.id,
        })
        .expect(200);
      expect(academySignIn.body.emailOtpRequired).not.toBe(true);
      const academyToken = academySignIn.body.accessToken as string;
      expect(typeof academyToken).toBe('string');

      const refused = await http()
        .get('/platform/contact-submissions')
        .set(bearer(academyToken));
      expect(refused.status).toBe(403);
      expect(refused.body.error.messageKey).toBe('errors.auth.managementSurfaceOnly');

      // The same person on the management surface is admitted.
      const managementSignIn = await http()
        .post('/auth/sign-in')
        .send({ email: staff.email, password: PASSWORD })
        .expect(200);
      await http()
        .get('/platform/contact-submissions')
        .set(bearer(managementSignIn.body.accessToken as string))
        .expect(200);
      await admin.user.update({
        where: { id: staff.userId },
        data: { isPlatformOwner: false },
      });
    });
  });

  // ---------------------------------------------------------------------
  // The Platform Owner's inbox
  // ---------------------------------------------------------------------

  describe('owner inbox', () => {
    it('lists with search, filters and pagination, and returns summary counts', async () => {
      const tag = randomUUID().slice(0, 8);
      const a = await storedEnquiry({
        organizationName: `Org-${tag}`,
        topic: 'partnership',
      });
      const b = await storedEnquiry({ organizationName: `Org-${tag}`, topic: 'support' });

      const byOrg = await http()
        .get('/platform/contact-submissions')
        .query({ search: `org-${tag}` })
        .set(bearer(ownerToken))
        .expect(200);
      expect(byOrg.body.items.map((i: { id: string }) => i.id).sort()).toEqual(
        [a.id, b.id].sort(),
      );
      expect(byOrg.body.items[0]).not.toHaveProperty('ipHash');

      const byTopic = await http()
        .get('/platform/contact-submissions')
        .query({ search: `org-${tag}`, topic: 'support' })
        .set(bearer(ownerToken))
        .expect(200);
      expect(byTopic.body.items.map((i: { id: string }) => i.id)).toEqual([b.id]);

      const paged = await http()
        .get('/platform/contact-submissions')
        .query({ search: `org-${tag}`, page: 2, pageSize: 1 })
        .set(bearer(ownerToken))
        .expect(200);
      expect(paged.body.items).toHaveLength(1);
      expect(paged.body.pagination).toMatchObject({
        page: 2,
        pageSize: 1,
        totalItems: 2,
        totalPages: 2,
      });

      const today = new Date().toISOString().slice(0, 10);
      const byDate = await http()
        .get('/platform/contact-submissions')
        .query({ search: `org-${tag}`, from: today, to: today, status: 'new' })
        .set(bearer(ownerToken))
        .expect(200);
      expect(byDate.body.pagination.totalItems).toBe(2);

      await http()
        .get('/platform/contact-submissions')
        .query({ status: 'bogus' })
        .set(bearer(ownerToken))
        .expect(400);

      const summary = await http()
        .get('/platform/contact-submissions/summary')
        .set(bearer(ownerToken))
        .expect(200);
      expect(summary.body.total).toBe(
        summary.body.new + summary.body.read + summary.body.archived,
      );
      expect(summary.body.new).toBeGreaterThanOrEqual(2);
    });

    it('reads one enquiry, moves it through statuses with audit rows, then deletes it with an audit row', async () => {
      const row = await storedEnquiry();

      const detail = await http()
        .get(`/platform/contact-submissions/${row.id}`)
        .set(bearer(ownerToken))
        .expect(200);
      expect(detail.body).toMatchObject({ id: row.id, status: 'new', readAt: null });

      const read = await http()
        .patch(`/platform/contact-submissions/${row.id}`)
        .set(bearer(ownerToken))
        .send({ status: 'read' })
        .expect(200);
      expect(read.body.status).toBe('read');
      expect(typeof read.body.readAt).toBe('string');

      const archived = await http()
        .patch(`/platform/contact-submissions/${row.id}`)
        .set(bearer(ownerToken))
        .send({ status: 'archived' })
        .expect(200);
      expect(archived.body.status).toBe('archived');
      expect(archived.body.readAt).toBe(read.body.readAt);

      await http()
        .patch(`/platform/contact-submissions/${row.id}`)
        .set(bearer(ownerToken))
        .send({ status: 'deleted' })
        .expect(400);
      await http()
        .patch(`/platform/contact-submissions/${row.id}`)
        .set(bearer(ownerToken))
        .send({ status: 'read', readAt: null })
        .expect(400);

      const statusAudits = await admin.auditLogEntry.findMany({
        where: { action: 'platform.contact_submission.status_changed', targetId: row.id },
        orderBy: { occurredAt: 'asc' },
      });
      expect(statusAudits).toHaveLength(2);
      expect(statusAudits.map((a) => a.context)).toEqual([
        { status: 'read', previousStatus: 'new' },
        { status: 'archived', previousStatus: 'read' },
      ]);
      expect(statusAudits[0]).toMatchObject({
        actorUserId: ownerUserId,
        targetType: 'platform_contact_submission',
      });
      expect(JSON.stringify(statusAudits)).not.toContain(row.email);

      await http()
        .delete(`/platform/contact-submissions/${row.id}`)
        .set(bearer(ownerToken))
        .expect(204);
      await expect(
        admin.platformContactSubmission.findUnique({ where: { id: row.id } }),
      ).resolves.toBeNull();
      const deleteAudits = await admin.auditLogEntry.findMany({
        where: { action: 'platform.contact_submission.deleted', targetId: row.id },
      });
      expect(deleteAudits).toHaveLength(1);
      expect(deleteAudits[0].actorUserId).toBe(ownerUserId);

      await http()
        .get(`/platform/contact-submissions/${row.id}`)
        .set(bearer(ownerToken))
        .expect(404);
      await http()
        .delete(`/platform/contact-submissions/${row.id}`)
        .set(bearer(ownerToken))
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------
  // The visitor's personal data in the notification pipeline
  // ---------------------------------------------------------------------

  describe('visitor personal data', () => {
    /** Rows in either table whose `values` mention `needle` anywhere. */
    async function rowsMentioning(needle: string) {
      const pattern = `%${needle}%`;
      const [outbox, notifications] = await Promise.all([
        admin.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "communication_outbox" WHERE "values"::text ILIKE ${pattern}`,
        admin.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "notifications" WHERE "values"::text ILIKE ${pattern}`,
      ]);
      return { outbox: outbox.length, notifications: notifications.length };
    }

    it('stays out of the in-app feed, leaves the outbox once sent, and leaves every row on delete', async () => {
      const emailTag = randomUUID();
      const messageTag = randomUUID();
      const body = enquiry({
        email: `Visitor-${emailTag}@Example.test`,
        message: `Please call me about pricing, reference ${messageTag}.`,
      });
      await submit(body).expect(201);
      const [row] = await rowsFor(body.email as string);
      expect(row).toBeDefined();
      await intake.drainNotifications();

      // In-app: one row per owner, the topic and nothing about the visitor.
      const notified = await admin.notification.findMany({
        where: { dedupeKey: `platform_contact_received:${row.id}` },
      });
      expect(notified.length).toBeGreaterThan(0);
      for (const notification of notified) {
        expect(notification.values).toEqual({ topic: 'sales' });
      }
      // Outbox: the email still needs the details until it is rendered.
      const ownerRow = await admin.communicationOutbox.findFirstOrThrow({
        where: { key: NOTIFICATION_KEY, entityId: row.id, recipientUserId: ownerUserId },
      });
      expect(JSON.stringify(ownerRow.values)).toContain(emailTag);
      await expect(rowsMentioning(emailTag)).resolves.toMatchObject({ notifications: 0 });
      await expect(rowsMentioning(messageTag)).resolves.toMatchObject({
        notifications: 0,
      });

      // Earlier cases mailed this owner too; a reached daily cap would
      // fold this email into a digest instead of sending it now.
      await redis.del(`comm:cap:${ownerUserId}:${new Date().toISOString().slice(0, 10)}`);
      await expect(dispatcher.dispatch(ownerRow.id, { made: 0, max: 6 })).resolves.toBe(
        'sent',
      );
      const sent = await admin.communicationOutbox.findUniqueOrThrow({
        where: { id: ownerRow.id },
      });
      expect(sent.state).toBe('dispatched');
      expect(sent.values).toEqual({ topic: 'sales' });

      // Delete: every outbox row of the enquiry is blanked, and the ones
      // still waiting (other owners') are suppressed rather than mailed.
      await http()
        .delete(`/platform/contact-submissions/${row.id}`)
        .set(bearer(ownerToken))
        .expect(204);
      const remaining = await admin.communicationOutbox.findMany({
        where: { key: NOTIFICATION_KEY, entityId: row.id },
      });
      expect(remaining.length).toBe(notified.length);
      for (const outboxRow of remaining) {
        expect(outboxRow.values).toEqual({ topic: 'sales' });
        expect(['pending', 'deferred']).not.toContain(outboxRow.state);
      }
      expect(remaining.find((r) => r.id === ownerRow.id)?.state).toBe('dispatched');
      await expect(rowsMentioning(emailTag)).resolves.toEqual({
        outbox: 0,
        notifications: 0,
      });
      await expect(rowsMentioning(messageTag)).resolves.toEqual({
        outbox: 0,
        notifications: 0,
      });
    });
  });

  // ---------------------------------------------------------------------
  // RLS, directly — no guards in the way
  // ---------------------------------------------------------------------

  describe('row-level security', () => {
    it('hides every row from tenant and anonymous contexts, and refuses their writes', async () => {
      const row = await storedEnquiry();
      const org = await seedOrganizationWithOwner(admin, tenantUserId, 'contact-rls-org');

      const asUser = await tenancy.runInUserContext(tenantUserId, async (tx) => ({
        count: await tx.platformContactSubmission.count(),
        updated: (
          await tx.platformContactSubmission.updateMany({
            where: { id: row.id },
            data: { status: 'archived' },
          })
        ).count,
        deleted: (
          await tx.platformContactSubmission.deleteMany({ where: { id: row.id } })
        ).count,
      }));
      expect(asUser).toEqual({ count: 0, updated: 0, deleted: 0 });

      const asTenant = await tenancy.runInTenantContext(org.id, (tx) =>
        tx.platformContactSubmission.count(),
      );
      expect(asTenant).toBe(0);

      const anonymous = await tenancy.runWithoutContext((tx) =>
        tx.platformContactSubmission.count(),
      );
      expect(anonymous).toBe(0);

      // A signed-in context cannot plant rows; only the anonymous intake can.
      await expect(
        tenancy.runInUserContext(tenantUserId, (tx) =>
          tx.platformContactSubmission.createMany({
            data: [
              {
                id: randomUUID(),
                name: 'Planted',
                email: 'planted@example.test',
                topic: 'other',
                message: 'This row should never be written.',
                locale: 'en',
                ipHash: 'x'.repeat(64),
              },
            ],
          }),
        ),
      ).rejects.toThrow();
      // Nor can the anonymous context insert a pre-triaged row.
      await expect(
        tenancy.runWithoutContext((tx) =>
          tx.platformContactSubmission.createMany({
            data: [
              {
                id: randomUUID(),
                name: 'Pre-read',
                email: 'preread@example.test',
                topic: 'other',
                message: 'This row should never be written.',
                locale: 'en',
                ipHash: 'x'.repeat(64),
                status: 'read',
              },
            ],
          }),
        ),
      ).rejects.toThrow();

      const asOwner = await tenancy.runInUserContext(ownerUserId, (tx) =>
        tx.platformContactSubmission.findUnique({ where: { id: row.id } }),
      );
      expect(asOwner?.status).toBe('new');
    });
  });
});
