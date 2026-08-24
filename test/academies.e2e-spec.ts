/**
 * Academy Management — functional/contract e2e suite (P3, master plan §21).
 * Exercises the real HTTP surface end-to-end: guards + services + RLS all
 * engaged together, exactly as a real client would call it. Tenant-
 * isolation-specific scenarios (P3-TENANT-001..010) live in
 * `academies-tenant-isolation.e2e-spec.ts`; the pure DB-level RLS proof
 * (no guards/services at all) lives in `rls-academies.e2e-spec.ts`.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedOrganizationWithOwner,
  seedMembership,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

async function signUpAndSignIn(
  app: INestApplication,
  label: string,
): Promise<{ userId: string; accessToken: string }> {
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
  return { userId: signIn.body.user.id, accessToken: signIn.body.accessToken };
}

describe('Academy Management (e2e) — functional/contract', () => {
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

  it('requires authentication on every route (401, not a silent pass-through)', async () => {
    await request(app.getHttpServer())
      .get('/academies')
      .query({ organizationId: randomUUID() })
      .expect(401);
    await request(app.getHttpServer()).post('/academies').send({}).expect(401);
    await request(app.getHttpServer()).get(`/academies/${randomUUID()}`).expect(401);
  });

  it('POST /academies without organizationId -> 400 (not 403, not 500)', async () => {
    const user = await signUpAndSignIn(app, 'academy-missing-org');
    const response = await request(app.getHttpServer())
      .post('/academies')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: 'No Org', slug: `no-org-${Date.now()}` });
    expect(response.status).toBe(400);
  });

  it('POST /academies with an invalid slug -> 400', async () => {
    const user = await signUpAndSignIn(app, 'academy-bad-slug');
    const org = await seedOrganizationWithOwner(
      admin,
      user.userId,
      'academy-bad-slug-org',
    );

    const response = await request(app.getHttpServer())
      .post('/academies')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ organizationId: org.id, name: 'Bad Slug', slug: 'Not A Valid Slug!' });
    expect(response.status).toBe(400);
  });

  it('full CRUD lifecycle: create -> get -> list -> update -> branding -> archive', async () => {
    const user = await signUpAndSignIn(app, 'academy-crud');
    const org = await seedOrganizationWithOwner(admin, user.userId, 'academy-crud-org');
    const slug = `academy-crud-${Date.now()}`;

    const created = await request(app.getHttpServer())
      .post('/academies')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ organizationId: org.id, name: 'CRUD Academy', slug })
      .expect(201);
    expect(created.body).toMatchObject({
      organizationId: org.id,
      name: 'CRUD Academy',
      slug,
      status: 'draft',
      timezone: 'UTC',
      language: 'en',
      currency: 'USD',
    });
    const academyId = created.body.id as string;

    await request(app.getHttpServer())
      .get(`/academies/${academyId}`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200)
      .expect((res) => expect(res.body.id).toBe(academyId));

    const list = await request(app.getHttpServer())
      .get('/academies')
      .query({ organizationId: org.id })
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    expect(list.body.items.map((a: { id: string }) => a.id)).toContain(academyId);
    expect(list.body.pagination).toEqual({
      page: 1,
      pageSize: 20,
      totalItems: expect.any(Number),
      totalPages: expect.any(Number),
    });

    const updated = await request(app.getHttpServer())
      .patch(`/academies/${academyId}`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: 'Renamed Academy', status: 'active' })
      .expect(200);
    expect(updated.body.name).toBe('Renamed Academy');
    expect(updated.body.status).toBe('active');
    expect(updated.body.organizationId).toBe(org.id); // never reassignable.

    const branded = await request(app.getHttpServer())
      .patch(`/academies/${academyId}/branding`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        logo: 'https://example.com/logo.png',
        favicon: 'https://example.com/f.ico',
      })
      .expect(200);
    expect(branded.body.logo).toBe('https://example.com/logo.png');
    expect(branded.body.favicon).toBe('https://example.com/f.ico');

    await request(app.getHttpServer())
      .delete(`/academies/${academyId}`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(204);

    const afterArchive = await request(app.getHttpServer())
      .get(`/academies/${academyId}`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    expect(afterArchive.body.status).toBe('archived'); // soft-delete only — the row still exists.

    const row = await admin.academy.findUniqueOrThrow({ where: { id: academyId } });
    expect(row.status).toBe('archived');
  });

  it('creating an academy auto-creates an owner-role academy_member row for the creator', async () => {
    const user = await signUpAndSignIn(app, 'academy-auto-owner');
    const org = await seedOrganizationWithOwner(
      admin,
      user.userId,
      'academy-auto-owner-org',
    );

    const created = await request(app.getHttpServer())
      .post('/academies')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        organizationId: org.id,
        name: 'Auto Owner',
        slug: `auto-owner-${Date.now()}`,
      })
      .expect(201);

    const members = await request(app.getHttpServer())
      .get(`/academies/${created.body.id}/members`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    expect(members.body.items).toHaveLength(1);
    expect(members.body.items[0]).toMatchObject({
      userId: user.userId,
      role: 'owner',
      status: 'active',
    });
  });

  it('duplicate slug -> 409, not a raw 500', async () => {
    const user = await signUpAndSignIn(app, 'academy-dup-slug');
    const org = await seedOrganizationWithOwner(
      admin,
      user.userId,
      'academy-dup-slug-org',
    );
    const slug = `dup-slug-${Date.now()}`;

    await request(app.getHttpServer())
      .post('/academies')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ organizationId: org.id, name: 'First', slug })
      .expect(201);

    const dup = await request(app.getHttpServer())
      .post('/academies')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ organizationId: org.id, name: 'Second', slug });
    expect(dup.status).toBe(409);
  });

  it('GET /academies/:id/stats reflects real academy_members counts, and publishedCourses is honestly 0', async () => {
    const user = await signUpAndSignIn(app, 'academy-stats');
    const org = await seedOrganizationWithOwner(admin, user.userId, 'academy-stats-org');

    const created = await request(app.getHttpServer())
      .post('/academies')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        organizationId: org.id,
        name: 'Stats Academy',
        slug: `stats-${Date.now()}`,
      })
      .expect(201);

    const otherUser = await signUpAndSignIn(app, 'academy-stats-staff');
    await seedMembership(admin, org.id, otherUser.userId, 'member');
    await admin.academyMember.create({
      data: { academyId: created.body.id, userId: otherUser.userId, role: 'staff' },
    });

    const stats = await request(app.getHttpServer())
      .get(`/academies/${created.body.id}/stats`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    expect(stats.body).toEqual({
      totalMembers: 2,
      activeStaff: 1,
      activeInstructors: 0,
      publishedCourses: 0,
    });
  });

  it('GET /academies/:id/activity returns a real, honestly-empty paginated page', async () => {
    const user = await signUpAndSignIn(app, 'academy-activity');
    const org = await seedOrganizationWithOwner(
      admin,
      user.userId,
      'academy-activity-org',
    );
    const created = await request(app.getHttpServer())
      .post('/academies')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        organizationId: org.id,
        name: 'Activity Academy',
        slug: `activity-${Date.now()}`,
      })
      .expect(201);

    const activity = await request(app.getHttpServer())
      .get(`/academies/${created.body.id}/activity`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    expect(activity.body).toEqual({
      items: [],
      pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 1 },
    });
  });
});
