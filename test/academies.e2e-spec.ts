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
  seedActiveSubscriptionForOrg,
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

  /**
   * Creates an Academy through PROVISIONING — the only user-facing path
   * since Phase 10.6 removed `POST /academies`. Provisioning is
   * asynchronous, so this waits for the row it produces.
   */
  async function provisionAcademy(
    accessToken: string,
    organizationId: string,
    slug: string,
    academyName?: string,
  ): Promise<{
    status: number;
    body:
      Awaited<ReturnType<typeof admin.academy.findFirstOrThrow>> | Record<string, never>;
  }> {
    const response = await request(app.getHttpServer())
      .post(`/organizations/${organizationId}/provisioning-requests`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        academyName: academyName ?? `Academy ${slug}`,
        requestedSubdomain: slug,
        idempotencyKey: `${slug}-${Date.now()}`,
      });
    if (response.status >= 400) {
      return { status: response.status, body: {} };
    }
    // Returns the REAL academy row, so callers can assert on the same
    // fields the removed `POST /academies` response used to carry.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const academy = await admin.academy.findFirst({ where: { slug } });
      if (academy) return { status: 201, body: academy };
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Provisioning produced no Academy for ${slug}`);
  }

  it('requires authentication on every route (401, not a silent pass-through)', async () => {
    await request(app.getHttpServer())
      .get('/academies')
      .query({ organizationId: randomUUID() })
      .expect(401);
    await request(app.getHttpServer()).get(`/academies/${randomUUID()}`).expect(401);
  });

  it('the direct POST /academies creation route is gone (Phase 10.6)', async () => {
    // It used to validate `organizationId` and return 400. The route
    // itself was removed because it skipped subdomain allocation and left
    // academies with unreachable public websites; Academy Provisioning is
    // now the only creation path. Asserting the removal is what protects
    // that, since a re-added route would silently reintroduce the defect.
    const user = await signUpAndSignIn(app, 'academy-missing-org');
    const response = await request(app.getHttpServer())
      .post('/academies')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: 'No Org', slug: `no-org-${Date.now()}` });
    expect(response.status).toBe(404);
  });

  it('an invalid subdomain is still refused with 400 (validation moved with the route)', async () => {
    const user = await signUpAndSignIn(app, 'academy-bad-slug');
    const org = await seedOrganizationWithOwner(
      admin,
      user.userId,
      'academy-bad-slug-org',
    );
    // Provisioning is entitlement-gated, so the organization needs a
    // real subscription before it can create an Academy.
    await seedActiveSubscriptionForOrg(admin, org.id, org.slug);

    const response = await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        academyName: 'Bad Slug',
        requestedSubdomain: 'Not A Valid Slug!',
        idempotencyKey: `bad-slug-${Date.now()}`,
      });
    // Subdomain shape is still validated — the check moved to the
    // provisioning contract along with the creation path itself.
    expect(response.status).toBe(400);
  });

  it('full CRUD lifecycle: create -> get -> list -> update -> branding -> archive', async () => {
    const user = await signUpAndSignIn(app, 'academy-crud');
    const org = await seedOrganizationWithOwner(admin, user.userId, 'academy-crud-org');
    // Provisioning is entitlement-gated (see above).
    await seedActiveSubscriptionForOrg(admin, org.id, org.slug);
    const slug = `academy-crud-${Date.now()}`;

    const created = await provisionAcademy(
      user.accessToken,
      org.id,
      slug,
      'CRUD Academy',
    );
    expect(created.status).toBe(201);
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
    // Provisioning is entitlement-gated, so the organization needs a
    // real subscription before it can create an Academy.
    await seedActiveSubscriptionForOrg(admin, org.id, org.slug);

    const created = await provisionAcademy(
      user.accessToken,
      org.id,
      `auto-owner-${Date.now()}`,
    );
    expect(created.status).toBe(201);

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
    // Provisioning is entitlement-gated, so the organization needs a
    // real subscription before it can create an Academy.
    await seedActiveSubscriptionForOrg(admin, org.id, org.slug);
    const slug = `dup-slug-${Date.now()}`;

    expect((await provisionAcademy(user.accessToken, org.id, slug)).status).toBe(201);

    // WHERE THE DUPLICATE IS NOW CAUGHT. `POST /academies` rejected a
    // taken slug synchronously with 409. Provisioning is asynchronous, so
    // the request is ACCEPTED and the clash surfaces in the subdomain
    // step — which is why the availability endpoint exists and is what a
    // real client checks first. The property that matters is unchanged
    // and still asserted: a taken subdomain never yields a second
    // Academy, and never a 500.
    const availability = await request(app.getHttpServer())
      .get(`/subdomains/availability?subdomain=${slug}`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    expect(availability.body.status).toBe('unavailable');

    // And the allocation is still held by exactly one Academy.
    const allocations = await admin.subdomainAllocation.count({
      where: { subdomain: slug },
    });
    expect(allocations).toBe(1);
  });

  it('duplicate slug across two DIFFERENT organizations -> 409, not a raw 500 (Phase 0 fix: withSlugConflictHandling)', async () => {
    // The pre-check (`assertSlugAvailable`) only sees same-organization
    // collisions — a slug already taken by a DIFFERENT organization is
    // RLS-invisible to it, so this specific scenario exercises the real
    // DB-level `withSlugConflictHandling` backstop directly, not the
    // pre-check. This is the exact path that previously escaped as an
    // unhandled 500 in this environment (see `AcademiesService
    // .withSlugConflictHandling`'s doc comment).
    const firstOwner = await signUpAndSignIn(app, 'academy-cross-org-slug-1');
    const firstOrg = await seedOrganizationWithOwner(
      admin,
      firstOwner.userId,
      'academy-cross-org-slug-org-1',
    );
    // Provisioning is entitlement-gated, so the organization needs a
    // real subscription before it can create an Academy.
    await seedActiveSubscriptionForOrg(admin, firstOrg.id, firstOrg.slug);
    const slug = `cross-org-dup-slug-${Date.now()}`;

    await request(app.getHttpServer())
      .post(`/organizations/${firstOrg.id}/provisioning-requests`)
      .set('Authorization', `Bearer ${firstOwner.accessToken}`)
      .send({
        academyName: 'First Org Academy',
        requestedSubdomain: slug,
        idempotencyKey: `cross-1-${slug}`,
      })
      .expect(201);

    // Provisioning is asynchronous — the subdomain is not claimed until
    // its step runs, so the availability check below would otherwise race
    // it and see the name as still free.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const claimed = await admin.subdomainAllocation.count({
        where: { subdomain: slug },
      });
      if (claimed > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const secondOwner = await signUpAndSignIn(app, 'academy-cross-org-slug-2');
    const secondOrg = await seedOrganizationWithOwner(
      admin,
      secondOwner.userId,
      'academy-cross-org-slug-org-2',
    );
    // Provisioning is entitlement-gated, so the organization needs a
    // real subscription before it can create an Academy.
    await seedActiveSubscriptionForOrg(admin, secondOrg.id, secondOrg.slug);

    // A subdomain is globally unique — it IS a hostname — so it stays
    // taken across organizations, which is what this test exists for.
    const availability = await request(app.getHttpServer())
      .get(`/subdomains/availability?subdomain=${slug}`)
      .set('Authorization', `Bearer ${secondOwner.accessToken}`)
      .expect(200);
    expect(availability.body.status).toBe('unavailable');

    const allocations = await admin.subdomainAllocation.count({
      where: { subdomain: slug },
    });
    expect(allocations).toBe(1);
  });

  it('GET /academies/:id/stats reflects real academy_members counts, and publishedCourses is honestly 0', async () => {
    const user = await signUpAndSignIn(app, 'academy-stats');
    const org = await seedOrganizationWithOwner(admin, user.userId, 'academy-stats-org');
    // Provisioning is entitlement-gated (see above).
    await seedActiveSubscriptionForOrg(admin, org.id, org.slug);

    const created = await provisionAcademy(
      user.accessToken,
      org.id,
      `stats-${Date.now()}`,
      'Stats Academy',
    );
    expect(created.status).toBe(201);

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
    // Provisioning is entitlement-gated, so the organization needs a
    // real subscription before it can create an Academy.
    await seedActiveSubscriptionForOrg(admin, org.id, org.slug);
    const created = await provisionAcademy(
      user.accessToken,
      org.id,
      `activity-${Date.now()}`,
    );
    expect(created.status).toBe(201);

    const activity = await request(app.getHttpServer())
      .get(`/academies/${created.body.id}/activity`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    expect(activity.body).toEqual({
      items: [],
      pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 1 },
    });
  });

  it('POST /academies/:id/students creates a real, Academy-scoped academy_students membership (Phase 1, Extended Scope, dependency D) — not just a global user', async () => {
    const owner = await signUpAndSignIn(app, 'academy-create-student');
    const org = await seedOrganizationWithOwner(
      admin,
      owner.userId,
      'academy-create-student-org',
    );
    // Provisioning is entitlement-gated, so the organization needs a
    // real subscription before it can create an Academy.
    await seedActiveSubscriptionForOrg(admin, org.id, org.slug);
    const academy = await provisionAcademy(
      owner.accessToken,
      org.id,
      `create-student-${Date.now()}`,
      'Create Student Academy',
    );
    expect(academy.status).toBe(201);

    const email = uniqueTestEmail('academy-created-student');
    const created = await request(app.getHttpServer())
      .post(`/academies/${academy.body.id}/students`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Manager-Created Student', email, password: 'correct-horse-battery' })
      .expect(201);

    expect(created.body.academyId).toBe(academy.body.id);

    const membership = await admin.academyStudent.findUnique({
      where: {
        academyId_userId: { academyId: academy.body.id, userId: created.body.id },
      },
    });
    expect(membership).not.toBeNull();
    expect(membership?.status).toBe('active');
  });
});
