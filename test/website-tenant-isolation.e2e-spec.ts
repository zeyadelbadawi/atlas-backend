/**
 * Website Builder tenant-isolation suite — P9-TENANT-001..006 (master plan
 * §18/§21 Phase P9), extending the permanent tenant-isolation suite
 * established in `tenant-isolation.e2e-spec.ts` (P2) through
 * `media-tenant-isolation.e2e-spec.ts` (P8) — one file per phase, same
 * pattern. Exercised through the real HTTP surface; the pure DB-level RLS
 * proof lives in `rls-website.e2e-spec.ts`.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedCourse,
  seedOrganizationWithOwner,
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

describe('Website Builder tenant isolation (e2e) — P9-TENANT-001..006', () => {
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

  async function seedManagedAcademy(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    return { owner, academy };
  }

  it("P9-TENANT-001: Organization B cannot read Organization A's website configuration by addressing Academy A's real id", async () => {
    const { owner: ownerA, academy: academyA } = await seedManagedAcademy('t9-001-a');
    await request(app.getHttpServer())
      .get(`/academies/${academyA.id}/website/configuration`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .expect(200);

    const { owner: ownerB } = await seedManagedAcademy('t9-001-b');

    await request(app.getHttpServer())
      .get(`/academies/${academyA.id}/website/configuration`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(403);
  });

  it("P9-TENANT-002: Organization B cannot read Organization A's website page by guessing its id", async () => {
    const { owner: ownerA, academy: academyA } = await seedManagedAcademy('t9-002-a');
    const created = await request(app.getHttpServer())
      .post(`/academies/${academyA.id}/website/pages`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ title: 'Secret Page', slug: 'secret-page' })
      .expect(201);

    const { owner: ownerB, academy: academyB } = await seedManagedAcademy('t9-002-b');

    // Owner B is legitimately authorized for their OWN academy, but
    // Academy A's page id resolves to nothing within academyB's scope.
    await request(app.getHttpServer())
      .get(`/academies/${academyB.id}/website/pages/${created.body.id}`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(404);

    // The stronger form: addressing Academy A directly is rejected at the guard layer.
    await request(app.getHttpServer())
      .get(`/academies/${academyA.id}/website/pages`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(403);
  });

  it("P9-TENANT-003: Organization B cannot update or delete Organization A's website page by direct id", async () => {
    const { owner: ownerA, academy: academyA } = await seedManagedAcademy('t9-003-a');
    const created = await request(app.getHttpServer())
      .post(`/academies/${academyA.id}/website/pages`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ title: 'Target Page', slug: 'target-page' })
      .expect(201);

    const { owner: ownerB, academy: academyB } = await seedManagedAcademy('t9-003-b');

    await request(app.getHttpServer())
      .patch(`/academies/${academyB.id}/website/pages/${created.body.id}`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ title: 'hijacked' })
      .expect(404);

    await request(app.getHttpServer())
      .delete(`/academies/${academyB.id}/website/pages/${created.body.id}`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(404);

    const row = await admin.websitePage.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(row.title).toBe('Target Page');
  });

  it("P9-TENANT-004: Organization B cannot publish Organization A's website configuration", async () => {
    const { owner: ownerA, academy: academyA } = await seedManagedAcademy('t9-004-a');
    await request(app.getHttpServer())
      .get(`/academies/${academyA.id}/website/configuration`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .expect(200);

    const { owner: ownerB } = await seedManagedAcademy('t9-004-b');

    await request(app.getHttpServer())
      .post(`/academies/${academyA.id}/website/publish`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(403);

    const row = await admin.websiteConfiguration.findUniqueOrThrow({
      where: { academyId: academyA.id },
    });
    expect(row.status).toBe('draft');
  });

  it("P9-TENANT-005: a featuredCourses section cannot reference another organization's course, even though the course id genuinely exists", async () => {
    const { owner: ownerA, academy: academyA } = await seedManagedAcademy('t9-005-a');
    const { academy: academyB } = await seedManagedAcademy('t9-005-b');
    const courseB = await seedCourse(admin, academyB.id, 'Org B Course');

    const created = await request(app.getHttpServer())
      .post(`/academies/${academyA.id}/website/pages`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ title: 'Cross Org Page', slug: 'cross-org-page' })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/academies/${academyA.id}/website/pages/${created.body.id}`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({
        sections: [
          {
            id: 'sec-cross',
            type: 'featuredCourses',
            enabled: true,
            visibility: { desktop: true, tablet: true, mobile: true },
            config: {
              title: 'Courses',
              mode: 'selected',
              courseIds: [courseB.id],
              layout: 'grid',
              count: 3,
              showPrice: true,
              showInstructor: true,
            },
          },
        ],
      })
      .expect(400);
  });

  it("P9-TENANT-006: Organization B's page list never includes Organization A's pages, even with a crafted search filter", async () => {
    const { owner: ownerA, academy: academyA } = await seedManagedAcademy('t9-006-a');
    const created = await request(app.getHttpServer())
      .post(`/academies/${academyA.id}/website/pages`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ title: 'unique-marker-page-title', slug: 'unique-marker-page' })
      .expect(201);

    const { owner: ownerB, academy: academyB } = await seedManagedAcademy('t9-006-b');

    const list = await request(app.getHttpServer())
      .get(`/academies/${academyB.id}/website/pages`)
      .query({ search: 'unique-marker-page-title' })
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(200);
    expect(list.body.items.map((p: { id: string }) => p.id)).not.toContain(
      created.body.id,
    );
  });
});
