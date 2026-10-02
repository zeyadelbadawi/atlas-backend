/**
 * The Academy Owner's Messages page — the website Contact form's
 * submissions, server-side (2 Oct 2026).
 *
 * Submissions were stored and listable, newest first, but with no search,
 * filter, sort or counts and no way back to "unread"; and no dashboard
 * page used them at all. Pinned here against the real database:
 *   - a message sent through the public form lands in that Academy's list;
 *   - search (name, email, message; case-insensitive), status, an
 *     inclusive received-date range and sorting are applied in the
 *     database, with exact totals and stable paging;
 *   - the summary counts per status;
 *   - status moves new ↔ read ↔ archived;
 *   - no parameter, id or filter reaches another Academy's messages, and
 *     a non-staff member or an outsider is refused;
 *   - bad query values are refused.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedAcademyStudent,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

interface Item {
  id: string;
  name: string;
  email: string;
  message: string;
  status: string;
  createdAt: string;
}

describe('Contact submissions management (e2e)', () => {
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

  async function account(label: string) {
    const email = uniqueTestEmail(label);
    const password = 'correct-horse-battery';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(200);
    return {
      userId: signIn.body.user.id as string,
      token: signIn.body.accessToken as string,
    };
  }

  async function managedAcademy(label: string) {
    const owner = await account(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    return { owner, org, academy };
  }

  async function publish(token: string, academyId: string) {
    await request(app.getHttpServer())
      .post(`/academies/${academyId}/website/publish`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
  }

  const list = (token: string, academyId: string, query: object = {}) =>
    request(app.getHttpServer())
      .get(`/academies/${academyId}/contact-submissions`)
      .query(query)
      .set('Authorization', `Bearer ${token}`);

  const ids = (body: { items: Item[] }) => body.items.map((item) => item.id);

  /** Messages with known names, emails, texts, statuses and dates. */
  async function seedMessages(academyId: string) {
    const rows = [
      {
        name: 'Amira Saleh',
        email: 'amira@example.com',
        message: 'Question about the React course',
        status: 'new',
        at: '2026-09-01T10:00:00Z',
      },
      {
        name: 'Bilal Haddad',
        email: 'bilal@example.org',
        message: 'Do you offer certificates?',
        status: 'read',
        at: '2026-09-05T09:00:00Z',
      },
      {
        name: 'Chloe Martin',
        email: 'chloe@example.com',
        message: 'Group pricing for 10 people',
        status: 'archived',
        at: '2026-09-10T23:30:00Z',
      },
      {
        name: 'Dina Youssef',
        email: 'dina@example.net',
        message: 'Is the REACT course in Arabic?',
        status: 'new',
        at: '2026-09-15T08:00:00Z',
      },
      {
        name: 'Ethan Brooks',
        email: 'ethan@example.com',
        message: 'Refund policy',
        status: 'read',
        at: '2026-09-20T12:00:00Z',
      },
    ] as const;
    const created = [];
    for (const row of rows) {
      created.push(
        await admin.contactSubmission.create({
          data: {
            academyId,
            name: row.name,
            email: row.email,
            message: row.message,
            status: row.status,
            createdAt: new Date(row.at),
          },
        }),
      );
    }
    return created;
  }

  it("a message sent through the public form appears in that Academy's list as new, and the summary counts it", async () => {
    const { owner, academy } = await managedAcademy('cs-public');
    await publish(owner.token, academy.id);
    const sent = await request(app.getHttpServer())
      .post(`/public/websites/${academy.id}/contact`)
      .send({
        name: 'Visitor One',
        email: 'visitor.one@example.com',
        message: 'Hello <b>there</b>',
      })
      .expect(201);

    const page = await list(owner.token, academy.id).expect(200);
    expect(page.body.items[0]).toMatchObject({
      id: sent.body.id,
      name: 'Visitor One',
      email: 'visitor.one@example.com',
      // Stored and returned as the text that was sent — never interpreted.
      message: 'Hello <b>there</b>',
      status: 'new',
    });
    const summary = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/contact-submissions/summary`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    expect(summary.body).toEqual({ total: 1, new: 1, read: 0, archived: 0 });
  });

  it('search, status, date range, sort and paging are applied server-side with exact totals', async () => {
    const { owner, academy } = await managedAcademy('cs-browse');
    const [amira, bilal, chloe, dina, ethan] = await seedMessages(academy.id);

    // Default: newest first.
    const all = await list(owner.token, academy.id).expect(200);
    expect(ids(all.body)).toEqual([ethan.id, dina.id, chloe.id, bilal.id, amira.id]);
    expect(all.body.pagination).toMatchObject({ page: 1, totalItems: 5, totalPages: 1 });

    // Search: message text, case-insensitive.
    const react = await list(owner.token, academy.id, { search: 'react' }).expect(200);
    expect(ids(react.body)).toEqual([dina.id, amira.id]);
    // Search: email and name.
    expect(
      ids((await list(owner.token, academy.id, { search: 'EXAMPLE.ORG' })).body),
    ).toEqual([bilal.id]);
    expect(
      ids((await list(owner.token, academy.id, { search: 'chloe mar' })).body),
    ).toEqual([chloe.id]);

    // Status.
    const unread = await list(owner.token, academy.id, { status: 'new' }).expect(200);
    expect(ids(unread.body)).toEqual([dina.id, amira.id]);
    expect(unread.body.pagination.totalItems).toBe(2);

    // Inclusive date range: 5 Sep – 10 Sep includes Chloe at 23:30 on the 10th.
    const range = await list(owner.token, academy.id, {
      from: '2026-09-05',
      to: '2026-09-10',
    }).expect(200);
    expect(ids(range.body)).toEqual([chloe.id, bilal.id]);

    // Combined: search + status + range.
    const combined = await list(owner.token, academy.id, {
      search: 'react',
      status: 'new',
      from: '2026-09-10',
    }).expect(200);
    expect(ids(combined.body)).toEqual([dina.id]);

    // Sort by name ascending, and oldest first.
    expect(
      ids(
        (await list(owner.token, academy.id, { sortBy: 'name', sortDirection: 'asc' }))
          .body,
      ),
    ).toEqual([amira.id, bilal.id, chloe.id, dina.id, ethan.id]);
    expect(
      ids(
        (
          await list(owner.token, academy.id, {
            sortBy: 'createdAt',
            sortDirection: 'asc',
          })
        ).body,
      )[0],
    ).toBe(amira.id);

    // Paging: 2 per page, stable and complete.
    const p1 = await list(owner.token, academy.id, { pageSize: 2, page: 1 }).expect(200);
    const p2 = await list(owner.token, academy.id, { pageSize: 2, page: 2 }).expect(200);
    const p3 = await list(owner.token, academy.id, { pageSize: 2, page: 3 }).expect(200);
    expect(p1.body.pagination).toMatchObject({ totalItems: 5, totalPages: 3 });
    expect([...ids(p1.body), ...ids(p2.body), ...ids(p3.body)]).toEqual([
      ethan.id,
      dina.id,
      chloe.id,
      bilal.id,
      amira.id,
    ]);

    // Nothing matches: an empty page, not an error.
    const none = await list(owner.token, academy.id, { search: 'no such words' }).expect(
      200,
    );
    expect(none.body).toMatchObject({ items: [], pagination: { totalItems: 0 } });

    const summary = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/contact-submissions/summary`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    expect(summary.body).toEqual({ total: 5, new: 2, read: 2, archived: 1 });
  });

  it('a message can be read, marked unread, archived and restored', async () => {
    const { owner, academy } = await managedAcademy('cs-status');
    const [amira] = await seedMessages(academy.id);
    const patch = (status: string) =>
      request(app.getHttpServer())
        .patch(`/academies/${academy.id}/contact-submissions/${amira.id}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ status });
    expect((await patch('read').expect(200)).body.status).toBe('read');
    expect((await patch('new').expect(200)).body.status).toBe('new');
    expect((await patch('archived').expect(200)).body.status).toBe('archived');
    expect((await patch('read').expect(200)).body.status).toBe('read');
    await patch('deleted').expect(400);
  });

  it('refuses bad query values', async () => {
    const { owner, academy } = await managedAcademy('cs-validate');
    for (const query of [
      { status: 'spam' },
      { from: '01/09/2026' },
      { to: 'yesterday' },
      { sortBy: 'message' },
      { sortDirection: 'up' },
      { pageSize: 500 },
      { page: 0 },
      { search: 'x'.repeat(201) },
    ]) {
      await list(owner.token, academy.id, query).expect(400);
    }
  });

  it("no id, filter or role reaches another Academy's messages", async () => {
    const a = await managedAcademy('cs-iso-a');
    const b = await managedAcademy('cs-iso-b');
    const [aMessage] = await seedMessages(a.academy.id);
    await seedMessages(b.academy.id);

    // B's Owner: A's list, summary and a status change are all refused.
    await list(b.owner.token, a.academy.id).expect((res) =>
      expect([403, 404]).toContain(res.status),
    );
    await request(app.getHttpServer())
      .get(`/academies/${a.academy.id}/contact-submissions/summary`)
      .set('Authorization', `Bearer ${b.owner.token}`)
      .expect((res) => expect([403, 404]).toContain(res.status));
    // A's message id through B's OWN academy route: not found, untouched.
    await request(app.getHttpServer())
      .patch(`/academies/${b.academy.id}/contact-submissions/${aMessage.id}`)
      .set('Authorization', `Bearer ${b.owner.token}`)
      .send({ status: 'archived' })
      .expect(404);
    expect(
      (await admin.contactSubmission.findUniqueOrThrow({ where: { id: aMessage.id } }))
        .status,
    ).toBe('new');

    // B's own list never contains A's rows, whatever the filter.
    for (const query of [
      {},
      { search: 'amira' },
      { status: 'new' },
      { from: '2000-01-01' },
    ]) {
      const page = await list(b.owner.token, b.academy.id, query).expect(200);
      expect(ids(page.body)).not.toContain(aMessage.id);
    }

    // A student and an instructor of A (not website staff) and an anonymous
    // caller are refused.
    const student = await account('cs-iso-student');
    await seedAcademyStudent(admin, a.academy.id, student.userId);
    const instructor = await account('cs-iso-instructor');
    await seedAcademyMember(admin, a.academy.id, instructor.userId, 'instructor');
    for (const outsider of [student, instructor]) {
      await list(outsider.token, a.academy.id).expect((res) =>
        expect([403, 404]).toContain(res.status),
      );
    }
    await request(app.getHttpServer())
      .get(`/academies/${a.academy.id}/contact-submissions`)
      .expect(401);
  });
});
