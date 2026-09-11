/**
 * Phase 11.8 — Support Center, tenant side (P118-SUP-001..018).
 *
 * WHAT WAS MISSING. Tenants could CREATE a ticket and LIST their tickets,
 * but there was no tenant-facing route to read one or to reply — so a
 * customer could file a ticket, support could answer it, and the customer
 * had no way to see the answer. These cover the two routes that close
 * that gap.
 *
 * THE ISOLATION TESTS ARE THE POINT. A support thread contains whatever a
 * customer chose to tell Atlas about their business, so leaking one
 * across tenants is worse than leaking most other rows. Isolation here is
 * enforced by the `support_cases_requester_select` /
 * `support_case_messages_requester_*` RLS policies, not by a check in the
 * service, so these assert the OUTCOME against a live database.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma, seedOrganizationWithOwner } from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

const PASSWORD = 'correct-horse-battery';

describe('Phase 11.8 support centre (e2e) — P118-SUP-001..018', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  async function signUp(label: string) {
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: `${label} user`, email, password: PASSWORD })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      email,
      userId: signIn.body.user.id as string,
      token: signIn.body.accessToken as string,
    };
  }

  /** A user who owns an organization, so they can file a ticket against it. */
  async function seedRequester(label: string) {
    const account = await signUp(label);
    const org = await seedOrganizationWithOwner(admin, account.userId, `${label}-org`);
    return { ...account, organizationId: org.id };
  }

  async function createTicket(
    token: string,
    organizationId: string,
    subject: string,
  ): Promise<{ id: string }> {
    const response = await request(app.getHttpServer())
      .post(`/organizations/${organizationId}/support-cases`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subject, description: 'The original problem description.' })
      .expect(201);
    return { id: response.body.id as string };
  }

  // ---------------- creating and listing ----------------

  it('P118-SUP-001 — a tenant can create a ticket and it appears in their list', async () => {
    const requester = await seedRequester('p118-001');

    const ticket = await createTicket(
      requester.token,
      requester.organizationId,
      'Cannot upload a course video',
    );

    const list = await request(app.getHttpServer())
      .get(`/organizations/${requester.organizationId}/support-cases`)
      .set('Authorization', `Bearer ${requester.token}`)
      .expect(200);

    expect(list.body.items.map((item: { id: string }) => item.id)).toContain(ticket.id);
  });

  it('P118-SUP-002 — a new ticket opens with the description as its first message', async () => {
    const requester = await seedRequester('p118-002');
    const ticket = await createTicket(requester.token, requester.organizationId, 'Help');

    const detail = await request(app.getHttpServer())
      .get(`/support-cases/mine/${ticket.id}`)
      .set('Authorization', `Bearer ${requester.token}`)
      .expect(200);

    expect(detail.body.status).toBe('open');
    expect(detail.body.messages).toHaveLength(1);
    expect(detail.body.messages[0].authorRole).toBe('requester');
    expect(detail.body.messages[0].body).toBe('The original problem description.');
  });

  // ---------------- the conversation ----------------

  it('P118-SUP-003 — a requester can reply, and the reply persists', async () => {
    const requester = await seedRequester('p118-003');
    const ticket = await createTicket(requester.token, requester.organizationId, 'Help');

    await request(app.getHttpServer())
      .post(`/support-cases/mine/${ticket.id}/messages`)
      .set('Authorization', `Bearer ${requester.token}`)
      .send({ body: 'Adding more detail: it fails on files over 100MB.' })
      .expect(201);

    // Re-read rather than trusting the write response — "persists" means
    // it is still there on a fresh request.
    const detail = await request(app.getHttpServer())
      .get(`/support-cases/mine/${ticket.id}`)
      .set('Authorization', `Bearer ${requester.token}`)
      .expect(200);

    expect(detail.body.messages).toHaveLength(2);
    expect(detail.body.messages[1].body).toContain('100MB');
  });

  it('P118-SUP-004 — messages are ordered oldest first, so the thread reads correctly', async () => {
    const requester = await seedRequester('p118-004');
    const ticket = await createTicket(requester.token, requester.organizationId, 'Help');

    for (const body of ['second', 'third', 'fourth']) {
      await request(app.getHttpServer())
        .post(`/support-cases/mine/${ticket.id}/messages`)
        .set('Authorization', `Bearer ${requester.token}`)
        .send({ body })
        .expect(201);
    }

    const detail = await request(app.getHttpServer())
      .get(`/support-cases/mine/${ticket.id}`)
      .set('Authorization', `Bearer ${requester.token}`)
      .expect(200);

    expect(detail.body.messages.map((message: { body: string }) => message.body)).toEqual(
      ['The original problem description.', 'second', 'third', 'fourth'],
    );
  });

  it('P118-SUP-005 — a requester CANNOT post a message attributed to an agent', async () => {
    // The forgery case: without the RLS `author_role = 'requester'` check,
    // a customer could fabricate an official Atlas reply in their own
    // thread and then point to it.
    const requester = await seedRequester('p118-005');
    const ticket = await createTicket(requester.token, requester.organizationId, 'Help');

    // The DTO whitelist refuses the unknown property outright (400), which
    // is a stronger outcome than accepting and ignoring it: the request
    // never reaches the service at all. Either 400 or a 201 that stored
    // `requester` would be acceptable; silently storing `agent` would not.
    const response = await request(app.getHttpServer())
      .post(`/support-cases/mine/${ticket.id}/messages`)
      .set('Authorization', `Bearer ${requester.token}`)
      .send({ body: 'We have refunded you in full.', authorRole: 'agent' });
    expect([201, 400]).toContain(response.status);

    const messages = await admin.supportCaseMessage.findMany({
      where: { caseId: ticket.id },
    });
    // Whatever the status code, no forged agent message exists.
    expect(messages.every((message) => message.authorRole === 'requester')).toBe(true);
  });

  it('P118-SUP-006 — a reply bumps the ticket so support sees the activity', async () => {
    const requester = await seedRequester('p118-006');
    const ticket = await createTicket(requester.token, requester.organizationId, 'Help');
    const before = await admin.supportCase.findUniqueOrThrow({
      where: { id: ticket.id },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    await request(app.getHttpServer())
      .post(`/support-cases/mine/${ticket.id}/messages`)
      .set('Authorization', `Bearer ${requester.token}`)
      .send({ body: 'Any update?' })
      .expect(201);

    const after = await admin.supportCase.findUniqueOrThrow({
      where: { id: ticket.id },
    });
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });

  it('P118-SUP-007 — an empty reply is refused', async () => {
    const requester = await seedRequester('p118-007');
    const ticket = await createTicket(requester.token, requester.organizationId, 'Help');

    await request(app.getHttpServer())
      .post(`/support-cases/mine/${ticket.id}/messages`)
      .set('Authorization', `Bearer ${requester.token}`)
      .send({ body: '' })
      .expect(400);
  });

  // ---------------- status behaviour ----------------

  it('P118-SUP-008 — a CLOSED ticket refuses replies', async () => {
    // Otherwise a customer types into a thread nobody is reading.
    const requester = await seedRequester('p118-008');
    const ticket = await createTicket(requester.token, requester.organizationId, 'Help');
    await admin.supportCase.update({
      where: { id: ticket.id },
      data: { status: 'closed' },
    });

    await request(app.getHttpServer())
      .post(`/support-cases/mine/${ticket.id}/messages`)
      .set('Authorization', `Bearer ${requester.token}`)
      .send({ body: 'One more thing' })
      .expect(409);
  });

  it('P118-SUP-009 — a RESOLVED ticket still accepts replies', async () => {
    // Deliberately different from closed: "actually, this is not fixed"
    // is exactly the case that must be able to reopen the conversation.
    const requester = await seedRequester('p118-009');
    const ticket = await createTicket(requester.token, requester.organizationId, 'Help');
    await admin.supportCase.update({
      where: { id: ticket.id },
      data: { status: 'resolved' },
    });

    await request(app.getHttpServer())
      .post(`/support-cases/mine/${ticket.id}/messages`)
      .set('Authorization', `Bearer ${requester.token}`)
      .send({ body: 'This is still happening.' })
      .expect(201);
  });

  it('P118-SUP-010 — a closed ticket is still readable', async () => {
    const requester = await seedRequester('p118-010');
    const ticket = await createTicket(requester.token, requester.organizationId, 'Help');
    await admin.supportCase.update({
      where: { id: ticket.id },
      data: { status: 'closed' },
    });

    const detail = await request(app.getHttpServer())
      .get(`/support-cases/mine/${ticket.id}`)
      .set('Authorization', `Bearer ${requester.token}`)
      .expect(200);
    expect(detail.body.status).toBe('closed');
  });

  // ---------------- isolation and authorization ----------------

  it('P118-SUP-011 — another tenant cannot read my ticket', async () => {
    const mine = await seedRequester('p118-011-mine');
    const theirs = await seedRequester('p118-011-theirs');
    const ticket = await createTicket(mine.token, mine.organizationId, 'Private matter');

    // 404, not 403 — a 403 would confirm the id is a real ticket.
    await request(app.getHttpServer())
      .get(`/support-cases/mine/${ticket.id}`)
      .set('Authorization', `Bearer ${theirs.token}`)
      .expect(404);
  });

  it('P118-SUP-012 — another tenant cannot reply into my ticket', async () => {
    const mine = await seedRequester('p118-012-mine');
    const theirs = await seedRequester('p118-012-theirs');
    const ticket = await createTicket(mine.token, mine.organizationId, 'Private matter');

    const response = await request(app.getHttpServer())
      .post(`/support-cases/mine/${ticket.id}/messages`)
      .set('Authorization', `Bearer ${theirs.token}`)
      .send({ body: 'Injected message' });
    expect([403, 404]).toContain(response.status);

    const messages = await admin.supportCaseMessage.findMany({
      where: { caseId: ticket.id },
    });
    expect(messages).toHaveLength(1);
  });

  it('P118-SUP-013 — a COLLEAGUE in the same organization cannot read my ticket', async () => {
    // Tenant isolation is not enough on its own here: a support thread is
    // personal, and `support_cases_requester_select` is scoped to the
    // requester, not to the organization.
    const owner = await seedRequester('p118-013-owner');
    const colleague = await signUp('p118-013-colleague');
    await admin.organizationMembership.create({
      data: {
        organizationId: owner.organizationId,
        userId: colleague.userId,
        role: 'manager',
      },
    });
    const ticket = await createTicket(owner.token, owner.organizationId, 'Personal');

    await request(app.getHttpServer())
      .get(`/support-cases/mine/${ticket.id}`)
      .set('Authorization', `Bearer ${colleague.token}`)
      .expect(404);
  });

  it("P118-SUP-014 — listing never returns another requester's tickets", async () => {
    const mine = await seedRequester('p118-014-mine');
    const theirs = await seedRequester('p118-014-theirs');
    const theirTicket = await createTicket(theirs.token, theirs.organizationId, 'Theirs');
    await createTicket(mine.token, mine.organizationId, 'Mine');

    const list = await request(app.getHttpServer())
      .get(`/organizations/${mine.organizationId}/support-cases`)
      .set('Authorization', `Bearer ${mine.token}`)
      .expect(200);

    const ids = list.body.items.map((item: { id: string }) => item.id);
    expect(ids).not.toContain(theirTicket.id);
  });

  it('P118-SUP-015 — an unauthenticated caller cannot read or reply', async () => {
    const requester = await seedRequester('p118-015');
    const ticket = await createTicket(requester.token, requester.organizationId, 'Help');

    await request(app.getHttpServer())
      .get(`/support-cases/mine/${ticket.id}`)
      .expect(401);
    await request(app.getHttpServer())
      .post(`/support-cases/mine/${ticket.id}/messages`)
      .send({ body: 'anon' })
      .expect(401);
  });

  it('P118-SUP-016 — a nonexistent ticket id returns 404, not a server error', async () => {
    const requester = await seedRequester('p118-016');

    await request(app.getHttpServer())
      .get('/support-cases/mine/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${requester.token}`)
      .expect(404);
  });

  it('P118-SUP-017 — a requester cannot reach the Platform-Owner support routes', async () => {
    const requester = await seedRequester('p118-017');
    const ticket = await createTicket(requester.token, requester.organizationId, 'Help');

    for (const path of ['/support-cases', `/support-cases/${ticket.id}`]) {
      const response = await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${requester.token}`);
      expect([403, 404]).toContain(response.status);
    }

    // And cannot change their own ticket's status.
    const patch = await request(app.getHttpServer())
      .patch(`/support-cases/${ticket.id}/status`)
      .set('Authorization', `Bearer ${requester.token}`)
      .send({ status: 'resolved' });
    expect([403, 404]).toContain(patch.status);
  });

  it('P118-SUP-018 — an agent reply is visible to the requester', async () => {
    // The whole reason the read route exists: support answers, and the
    // customer must be able to see it.
    const requester = await seedRequester('p118-018');
    const ticket = await createTicket(requester.token, requester.organizationId, 'Help');

    // Written directly as the platform side would write it.
    await admin.supportCaseMessage.create({
      data: {
        caseId: ticket.id,
        authorName: 'Atlas Support',
        authorRole: 'agent',
        body: 'We have reproduced this and are working on it.',
      },
    });

    const detail = await request(app.getHttpServer())
      .get(`/support-cases/mine/${ticket.id}`)
      .set('Authorization', `Bearer ${requester.token}`)
      .expect(200);

    const agentMessages = detail.body.messages.filter(
      (message: { authorRole: string }) => message.authorRole === 'agent',
    );
    expect(agentMessages).toHaveLength(1);
    expect(agentMessages[0].body).toContain('reproduced');
  });
});
