/**
 * Customer Requests — end to end against real PostgreSQL (RLS) and Redis.
 *
 *   CR-01  an academy owner files a request: one row, one `created` event,
 *          an audit entry, the requester's confirmation — and a retried
 *          submit (same client id) returns the same request
 *   CR-02  routing: the configured team inbox gets exactly one email (an
 *          address row with NO tenant ids); with no inbox configured every
 *          Platform Owner is emailed; the dispatcher really sends it there
 *   CR-03  RBAC: administrator yes; manager/instructor/other org/learner no;
 *          another academy's request id is 404
 *   CR-04  contextual details are validated per type
 *   CR-05  the console: list/filter/search/counts, Platform Owners only
 *   CR-06  lifecycle: valid moves notify the requester; invalid → 409;
 *          a customer reply while waiting → back in progress + team email
 *   CR-07  internal notes and assignment never reach the academy — not via
 *          the API and not via the database (RLS)
 *   CR-08  cancel; nothing can be added to a closed request
 *   CR-09  assignment: only a Platform Owner; the assignee alone hears replies
 *   CR-10  routing configuration is Platform-Owner-only, also in RLS
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
  seedMembership,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { CommunicationDispatchService } from '../src/communications/services/communication-dispatch.service';

jest.setTimeout(240000);
const PASSWORD = 'correct-horse-battery-requests';

describe('Customer Requests (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let tenancy: TenancyContextService;
  let dispatcher: CommunicationDispatchService;
  let stubSend: jest.SpyInstance;
  const sent: { to: string; subject: string }[] = [];

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    flush = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
    tenancy = app.get(TenancyContextService, { strict: false });
    dispatcher = app.get(CommunicationDispatchService, { strict: false });
    stubSend = jest
      .spyOn(testApp.stubEmailProvider, 'send')
      .mockImplementation(async (input: { to: string; subject: string }) => {
        sent.push({ to: input.to, subject: input.subject });
        return { providerMessageId: `cr-${sent.length}`, provider: 'stub' };
      });
  });

  afterAll(async () => {
    stubSend.mockRestore();
    await admin.customerRequestRoutingRule.deleteMany({});
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
    await admin.customerRequestRoutingRule.deleteMany({});
  });

  const http = () => request(app.getHttpServer());

  async function account(label: string) {
    await flush();
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .send({ name: `${label} person`, email, password: PASSWORD })
      .expect(201);
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    await admin.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date() },
    });
    return { email, userId: user.id };
  }

  async function signIn(email: string) {
    await flush();
    const res = await http()
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return { Authorization: `Bearer ${res.body.accessToken as string}` };
  }

  async function platformOwner(label: string) {
    const person = await account(label);
    await admin.user.update({
      where: { id: person.userId },
      data: { isPlatformOwner: true },
    });
    return { ...person, auth: await signIn(person.email) };
  }

  async function academyWorld(label: string) {
    const owner = await account(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    return { org, academy, owner: { ...owner, auth: await signIn(owner.email) } };
  }

  async function staff(
    w: Awaited<ReturnType<typeof academyWorld>>,
    label: string,
    role: 'administrator' | 'manager' | 'instructor',
  ) {
    const person = await account(label);
    await seedMembership(admin, w.org.id, person.userId, 'member');
    await seedAcademyMember(admin, w.academy.id, person.userId, role);
    return { ...person, auth: await signIn(person.email) };
  }

  function file(
    w: { academy: { id: string } },
    auth: Record<string, string>,
    overrides: Record<string, unknown> = {},
  ) {
    return http()
      .post(`/academies/${w.academy.id}/customer-requests`)
      .set(auth)
      .send({
        type: 'logo',
        title: 'A logo for our academy',
        description: 'We need a clean, modern logo that works in Arabic and English.',
        priority: 'normal',
        details: { brandName: 'Nour Academy', colors: 'teal and gold' },
        clientRequestId: randomUUID(),
        ...overrides,
      });
  }

  const outbox = (key: string, entityId: string) =>
    admin.communicationOutbox.findMany({
      where: { key, entityId },
      orderBy: { createdAt: 'asc' },
    });

  it('CR-01 — files a request once, with its history, audit entry and confirmation', async () => {
    const w = await academyWorld('cr01');
    const clientRequestId = randomUUID();
    const first = await file(w, w.owner.auth, { clientRequestId }).expect(201);
    expect(first.body).toMatchObject({
      type: 'logo',
      status: 'submitted',
      academy: { id: w.academy.id },
      details: { brandName: 'Nour Academy', colors: 'teal and gold' },
      canCancel: true,
      canReply: true,
    });
    expect(first.body.reference).toMatch(/^CR-[0-9A-F]{8}$/);
    expect(first.body.events.map((e: { kind: string }) => e.kind)).toEqual(['created']);

    // The same submit again (a double click, a retried request): same row.
    const again = await file(w, w.owner.auth, { clientRequestId }).expect(201);
    expect(again.body.id).toBe(first.body.id);
    expect(
      await admin.customerRequest.count({ where: { academyId: w.academy.id } }),
    ).toBe(1);

    expect(
      await admin.auditLogEntry.count({
        where: { action: 'customer_request.created', targetId: first.body.id },
      }),
    ).toBe(1);
    const confirmation = await outbox('customer_request.submitted', first.body.id);
    expect(confirmation).toHaveLength(1);
    expect(confirmation[0].recipientUserId).toBe(w.owner.userId);
  });

  it('CR-02 — routes to the configured inbox (no tenant ids on the row), else to Platform Owners; the email really goes there', async () => {
    const owner = await platformOwner('cr02-po');
    await http()
      .put('/platform/customer-request-routing')
      .set(owner.auth)
      .send({ rules: [{ type: 'domain', email: 'Domain-Team@Example.test' }] })
      .expect(200);

    const w = await academyWorld('cr02');
    const domain = await file(w, w.owner.auth, {
      type: 'domain',
      title: 'Use our own domain',
      details: { desiredDomain: 'nour.example', alreadyOwned: true },
    }).expect(201);
    const routed = await outbox('customer_request.routed', domain.body.id);
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({
      recipientUserId: null,
      recipientEmail: 'domain-team@example.test',
      organizationId: null,
      academyId: null,
    });

    // The real pipeline (outbox → worker → provider) delivers it to the inbox.
    let delivered: { to: string; subject: string } | undefined;
    for (let attempt = 0; attempt < 60 && !delivered; attempt += 1) {
      delivered = sent.find((mail) => mail.to === 'domain-team@example.test');
      if (!delivered) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(delivered?.subject).toContain('Use our own domain');
    const row = await admin.communicationOutbox.findUniqueOrThrow({
      where: { id: routed[0].id },
    });
    expect(row.state).toBe('dispatched');
    // Delivered once — a manual re-dispatch of the same row sends nothing.
    expect(await dispatcher.dispatch(routed[0].id, { made: 1, max: 6 })).toBe('skipped');
    expect(sent.filter((mail) => mail.to === 'domain-team@example.test')).toHaveLength(1);

    // No inbox for `theme`: every active Platform Owner is emailed instead.
    const theme = await file(w, w.owner.auth, { type: 'theme', details: {} }).expect(201);
    const fallback = await outbox('customer_request.routed', theme.body.id);
    expect(fallback.map((row) => row.recipientEmail)).toContain(
      owner.email.toLowerCase(),
    );
    // …and every Platform Owner's feed shows it.
    expect(
      (await outbox('customer_request.received', theme.body.id)).map(
        (r) => r.recipientUserId,
      ),
    ).toContain(owner.userId);
  });

  it('CR-03 — owner and administrator only; another academy’s request is 404', async () => {
    const w = await academyWorld('cr03');
    const administrator = await staff(w, 'cr03-admin', 'administrator');
    const manager = await staff(w, 'cr03-manager', 'manager');
    const instructor = await staff(w, 'cr03-instructor', 'instructor');
    const outsider = await academyWorld('cr03-other');

    await file(w, administrator.auth).expect(201);
    await file(w, manager.auth).expect(403);
    await file(w, instructor.auth).expect(403);
    await file(w, outsider.owner.auth).expect(403);
    await http()
      .get(`/academies/${w.academy.id}/customer-requests`)
      .set(manager.auth)
      .expect(403);

    // A second academy of the SAME organization: its request is invisible here.
    const sibling = await seedAcademy(admin, w.org.id, 'cr03-sibling');
    await seedAcademyMember(admin, sibling.id, w.owner.userId, 'owner');
    const theirs = await file({ academy: sibling }, w.owner.auth).expect(201);
    await http()
      .get(`/academies/${w.academy.id}/customer-requests/${theirs.body.id}`)
      .set(w.owner.auth)
      .expect(404);
    const listed = await http()
      .get(`/academies/${w.academy.id}/customer-requests`)
      .set(w.owner.auth)
      .expect(200);
    expect(listed.body.items.map((i: { id: string }) => i.id)).not.toContain(
      theirs.body.id,
    );
  });

  it('CR-04 — contextual details are validated per type', async () => {
    const w = await academyWorld('cr04');
    await file(w, w.owner.auth, {
      type: 'logo',
      details: { desiredDomain: 'x.test' },
    }).expect(400);
    await file(w, w.owner.auth, {
      type: 'domain',
      details: { alreadyOwned: 'yes' },
    }).expect(400);
    await file(w, w.owner.auth, {
      type: 'logo',
      details: { style: 'x'.repeat(501) },
    }).expect(400);
    await file(w, w.owner.auth, { type: 'spaceship' }).expect(400);
    await file(w, w.owner.auth, { title: 'ab' }).expect(400);
  });

  it('CR-05 — the console lists, filters, searches and counts — for Platform Owners only', async () => {
    const owner = await platformOwner('cr05-po');
    const w = await academyWorld('cr05');
    const logo = await file(w, w.owner.auth, {
      title: `Zebra logo ${randomUUID()}`,
    }).expect(201);
    await file(w, w.owner.auth, { type: 'custom_feature', details: {} }).expect(201);

    const byAcademy = await http()
      .get('/platform/customer-requests')
      .query({ academyId: w.academy.id })
      .set(owner.auth)
      .expect(200);
    expect(byAcademy.body.items).toHaveLength(2);
    const byType = await http()
      .get('/platform/customer-requests')
      .query({ academyId: w.academy.id, type: 'logo' })
      .set(owner.auth)
      .expect(200);
    expect(byType.body.items.map((i: { id: string }) => i.id)).toEqual([logo.body.id]);
    const bySearch = await http()
      .get('/platform/customer-requests')
      .query({ search: logo.body.title })
      .set(owner.auth)
      .expect(200);
    expect(bySearch.body.items.map((i: { id: string }) => i.id)).toEqual([logo.body.id]);
    const counts = await http()
      .get('/platform/customer-requests/counts')
      .set(owner.auth)
      .expect(200);
    expect(counts.body.open).toBeGreaterThanOrEqual(2);

    await http().get('/platform/customer-requests').set(w.owner.auth).expect(403);
    await http()
      .get(`/platform/customer-requests/${logo.body.id}`)
      .set(w.owner.auth)
      .expect(403);
  });

  it('CR-06 — valid moves notify the requester; invalid moves are refused; a customer reply while waiting puts it back in progress', async () => {
    const owner = await platformOwner('cr06-po');
    const w = await academyWorld('cr06');
    const created = await file(w, w.owner.auth).expect(201);
    const id = created.body.id as string;

    await http()
      .patch(`/platform/customer-requests/${id}`)
      .set(owner.auth)
      .send({ status: 'waiting_for_customer', note: 'Which colours do you prefer?' })
      .expect(200);
    const changed = await outbox('customer_request.status_changed', id);
    expect(changed).toHaveLength(1);
    expect(changed[0].recipientUserId).toBe(w.owner.userId);
    expect(await outbox('customer_request.team_replied', id)).toHaveLength(1);

    await http()
      .patch(`/platform/customer-requests/${id}`)
      .set(owner.auth)
      .send({ status: 'cancelled' })
      .expect(409);

    const replied = await http()
      .post(`/academies/${w.academy.id}/customer-requests/${id}/messages`)
      .set(w.owner.auth)
      .send({ body: 'Teal and gold, please.' })
      .expect(201);
    expect(replied.body.status).toBe('in_progress');
    const teamMail = (await outbox('customer_request.routed', id)).filter(
      (row) => (row.values as { event?: string }).event === 'customer_message',
    );
    expect(teamMail.length).toBeGreaterThan(0);

    await http()
      .patch(`/platform/customer-requests/${id}`)
      .set(owner.auth)
      .send({ status: 'completed' })
      .expect(200);
    const view = await http()
      .get(`/academies/${w.academy.id}/customer-requests/${id}`)
      .set(w.owner.auth)
      .expect(200);
    expect(view.body).toMatchObject({
      status: 'completed',
      canReply: false,
      canCancel: false,
    });
    expect(view.body.events.map((e: { kind: string }) => e.kind)).toEqual([
      'created',
      'status_changed',
      'team_message',
      'customer_message',
      'status_changed',
      'status_changed',
    ]);
  });

  it('CR-07 — internal notes and assignment never reach the academy: not via the API, not via the database', async () => {
    const owner = await platformOwner('cr07-po');
    const w = await academyWorld('cr07');
    const id = (await file(w, w.owner.auth).expect(201)).body.id as string;

    await http()
      .post(`/platform/customer-requests/${id}/messages`)
      .set(owner.auth)
      .send({ body: 'SECRET: quote them double.', internal: true })
      .expect(201);
    await http()
      .patch(`/platform/customer-requests/${id}`)
      .set(owner.auth)
      .send({ assigneeUserId: owner.userId })
      .expect(200);

    const console = await http()
      .get(`/platform/customer-requests/${id}`)
      .set(owner.auth)
      .expect(200);
    expect(console.body.events.map((e: { kind: string }) => e.kind)).toEqual(
      expect.arrayContaining(['internal_note', 'assigned']),
    );

    const view = await http()
      .get(`/academies/${w.academy.id}/customer-requests/${id}`)
      .set(w.owner.auth)
      .expect(200);
    expect(JSON.stringify(view.body)).not.toContain('SECRET');
    expect(view.body.events.map((e: { kind: string }) => e.kind)).toEqual(['created']);
    expect(view.body).not.toHaveProperty('assignee');
    // No email or in-app notification for an internal note.
    expect(await outbox('customer_request.team_replied', id)).toHaveLength(0);

    // The database itself: the tenant context sees no internal row at all.
    const visible = await tenancy.runInTenantAndUserContext(
      w.org.id,
      w.owner.userId,
      (tx) => tx.customerRequestEvent.findMany({ where: { requestId: id } }),
    );
    expect(visible.every((event) => event.visibility === 'customer')).toBe(true);
    expect(visible.some((event) => event.body?.includes('SECRET'))).toBe(false);
  });

  it('CR-08 — the customer may cancel; nothing is added to a closed request', async () => {
    const owner = await platformOwner('cr08-po');
    const w = await academyWorld('cr08');
    const id = (await file(w, w.owner.auth).expect(201)).body.id as string;

    const cancelled = await http()
      .post(`/academies/${w.academy.id}/customer-requests/${id}/cancel`)
      .set(w.owner.auth)
      .expect(201);
    expect(cancelled.body.status).toBe('cancelled');
    await http()
      .post(`/academies/${w.academy.id}/customer-requests/${id}/cancel`)
      .set(w.owner.auth)
      .expect(409);
    await http()
      .post(`/academies/${w.academy.id}/customer-requests/${id}/messages`)
      .set(w.owner.auth)
      .send({ body: 'Never mind' })
      .expect(409);
    await http()
      .post(`/platform/customer-requests/${id}/messages`)
      .set(owner.auth)
      .send({ body: 'Hello?' })
      .expect(409);
    await http()
      .patch(`/platform/customer-requests/${id}`)
      .set(owner.auth)
      .send({ status: 'in_progress' })
      .expect(409);
    // A team note on a closed request is still allowed (internal record).
    await http()
      .post(`/platform/customer-requests/${id}/messages`)
      .set(owner.auth)
      .send({ body: 'Customer cancelled after the call.', internal: true })
      .expect(201);
  });

  it('CR-09 — only a Platform Owner can be assigned, and the assignee alone hears the customer', async () => {
    const owner = await platformOwner('cr09-po');
    const colleague = await platformOwner('cr09-po2');
    const w = await academyWorld('cr09');
    const id = (await file(w, w.owner.auth).expect(201)).body.id as string;

    await http()
      .patch(`/platform/customer-requests/${id}`)
      .set(owner.auth)
      .send({ assigneeUserId: w.owner.userId })
      .expect(400);
    await http()
      .patch(`/platform/customer-requests/${id}`)
      .set(owner.auth)
      .send({ assigneeUserId: colleague.userId })
      .expect(200);

    await http()
      .post(`/academies/${w.academy.id}/customer-requests/${id}/messages`)
      .set(w.owner.auth)
      .send({ body: 'Any news?' })
      .expect(201);
    const heard = await outbox('customer_request.customer_replied', id);
    expect(heard.map((row) => row.recipientUserId)).toEqual([colleague.userId]);
  });

  it('CR-10 — routing configuration is Platform-Owner-only, in the API and in RLS', async () => {
    const owner = await platformOwner('cr10-po');
    const w = await academyWorld('cr10');
    await http()
      .put('/platform/customer-request-routing')
      .set(owner.auth)
      .send({ rules: [{ type: 'logo', email: 'design@example.test' }] })
      .expect(200);
    const rules = await http()
      .get('/platform/customer-request-routing')
      .set(owner.auth)
      .expect(200);
    expect(rules.body).toHaveLength(5);
    expect(rules.body.find((r: { type: string }) => r.type === 'logo').email).toBe(
      'design@example.test',
    );
    await http()
      .put('/platform/customer-request-routing')
      .set(owner.auth)
      .send({ rules: [{ type: 'logo', email: 'not-an-email' }] })
      .expect(400);

    await http().get('/platform/customer-request-routing').set(w.owner.auth).expect(403);
    const seen = await tenancy.runInTenantAndUserContext(w.org.id, w.owner.userId, (tx) =>
      tx.customerRequestRoutingRule.findMany(),
    );
    expect(seen).toHaveLength(0);
    // And the routed email row is not readable by the tenant either.
    const id = (await file(w, w.owner.auth).expect(201)).body.id as string;
    const tenantOutbox = await tenancy.runInTenantAndUserContext(
      w.org.id,
      w.owner.userId,
      (tx) =>
        tx.communicationOutbox.findMany({
          where: { key: 'customer_request.routed', entityId: id },
        }),
    );
    expect(tenantOutbox).toHaveLength(0);
  });
});
