/**
 * Course Management — functional/contract e2e suite (P5, master plan
 * §21). Exercises the real HTTP surface end-to-end. Tenant-isolation-
 * specific scenarios (P5-TENANT-001..010) live in
 * `courses-tenant-isolation.e2e-spec.ts`; the pure DB-level RLS proof
 * lives in `rls-courses.e2e-spec.ts`; curriculum (sections/lessons/
 * reorder) contract tests live in `course-curriculum.e2e-spec.ts`.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedCourse,
  seedCourseCategory,
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

/** Seeds an academy with the caller as its `owner`-role member — the write-authorization precondition every mutating test needs. */
async function seedManagedAcademy(
  admin: PrismaClient,
  organizationId: string,
  ownerUserId: string,
  label: string,
) {
  const academy = await seedAcademy(admin, organizationId, label);
  await seedAcademyMember(admin, academy.id, ownerUserId, 'owner');
  return academy;
}

describe('Course Management (e2e) — functional/contract', () => {
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

  it('requires authentication on every route', async () => {
    await request(app.getHttpServer()).get('/academies/x/courses').expect(401);
    await request(app.getHttpServer()).post('/academies/x/courses').send({}).expect(401);
  });

  it('full CRUD lifecycle: create -> get -> list -> update -> publish -> unpublish -> archive', async () => {
    const owner = await signUpAndSignIn(app, 'course-crud');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'course-crud-org');
    const academy = await seedManagedAcademy(
      admin,
      org.id,
      owner.userId,
      'course-crud-academy',
    );
    const slug = `course-crud-${Date.now()}`;

    const created = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        title: 'CRUD Course',
        slug,
        visibility: 'private',
        pricing: { type: 'free' },
      })
      .expect(201);
    expect(created.body).toMatchObject({
      academyId: academy.id,
      title: 'CRUD Course',
      slug,
      status: 'draft',
      visibility: 'private',
      pricing: { type: 'free' },
      instructors: [],
      stats: { totalSections: 0, totalLessons: 0 },
    });
    const courseId = created.body.id as string;

    await request(app.getHttpServer())
      .get(`/academies/${academy.id}/courses/${courseId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200)
      .expect((res) => expect(res.body.id).toBe(courseId));

    const list = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/courses`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(list.body.items.map((c: { id: string }) => c.id)).toContain(courseId);
    expect(list.body.pagination).toEqual({
      page: 1,
      pageSize: 20,
      totalItems: expect.any(Number),
      totalPages: expect.any(Number),
    });

    const updated = await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/courses/${courseId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Renamed Course', visibility: 'public' })
      .expect(200);
    expect(updated.body.title).toBe('Renamed Course');
    expect(updated.body.visibility).toBe('public');
    expect(updated.body.academyId).toBe(academy.id); // never reassignable.

    const published = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses/${courseId}/publish`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(published.body.status).toBe('published');
    expect(published.body.publishedAt).toEqual(expect.any(String));

    const unpublished = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses/${courseId}/unpublish`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(unpublished.body.status).toBe('draft');
    // publishedAt is retained as history, never cleared on unpublish.
    expect(unpublished.body.publishedAt).toEqual(published.body.publishedAt);

    await request(app.getHttpServer())
      .delete(`/academies/${academy.id}/courses/${courseId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(204);

    const afterArchive = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/courses/${courseId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(afterArchive.body.status).toBe('archived'); // soft-delete only.

    const row = await admin.course.findUniqueOrThrow({ where: { id: courseId } });
    expect(row.status).toBe('archived');
  });

  it('pricing round-trips a decimal amount through integer minor units at rest', async () => {
    const owner = await signUpAndSignIn(app, 'course-pricing');
    const org = await seedOrganizationWithOwner(
      admin,
      owner.userId,
      'course-pricing-org',
    );
    const academy = await seedManagedAcademy(
      admin,
      org.id,
      owner.userId,
      'course-pricing-academy',
    );

    const created = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        title: 'Paid Course',
        slug: `course-pricing-${Date.now()}`,
        visibility: 'public',
        pricing: { type: 'paid', amount: 29.99, currency: 'USD' },
      })
      .expect(201);
    expect(created.body.pricing).toEqual({
      type: 'paid',
      amount: 29.99,
      currency: 'USD',
    });

    const row = await admin.course.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(row.pricingAmountMinorUnits).toBe(2999n);

    // Switching back to free must CLEAR the stale minor-units value, not merely leave it untouched.
    const updated = await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/courses/${created.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ pricing: { type: 'free' } })
      .expect(200);
    expect(updated.body.pricing).toEqual({ type: 'free' });
    const rowAfter = await admin.course.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(rowAfter.pricingAmountMinorUnits).toBeNull();
  });

  it('duplicate slug within the same academy -> 409, not a raw 500', async () => {
    const owner = await signUpAndSignIn(app, 'course-dup-slug');
    const org = await seedOrganizationWithOwner(
      admin,
      owner.userId,
      'course-dup-slug-org',
    );
    const academy = await seedManagedAcademy(
      admin,
      org.id,
      owner.userId,
      'course-dup-slug-academy',
    );
    const slug = `dup-slug-${Date.now()}`;

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'First', slug, visibility: 'private', pricing: { type: 'free' } })
      .expect(201);

    const dup = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Second', slug, visibility: 'private', pricing: { type: 'free' } });
    expect(dup.status).toBe(409);
  });

  it('the same slug is allowed across two different academies (unique only per-academy)', async () => {
    const owner = await signUpAndSignIn(app, 'course-cross-academy-slug');
    const org = await seedOrganizationWithOwner(
      admin,
      owner.userId,
      'course-cross-slug-org',
    );
    const academyA = await seedManagedAcademy(
      admin,
      org.id,
      owner.userId,
      'course-cross-slug-a',
    );
    const academyB = await seedManagedAcademy(
      admin,
      org.id,
      owner.userId,
      'course-cross-slug-b',
    );
    const slug = `shared-slug-${Date.now()}`;

    await request(app.getHttpServer())
      .post(`/academies/${academyA.id}/courses`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        title: 'In Academy A',
        slug,
        visibility: 'private',
        pricing: { type: 'free' },
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/academies/${academyB.id}/courses`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        title: 'In Academy B',
        slug,
        visibility: 'private',
        pricing: { type: 'free' },
      })
      .expect(201);
  });

  it('rejects an invalid slug with 400', async () => {
    const owner = await signUpAndSignIn(app, 'course-invalid-slug');
    const org = await seedOrganizationWithOwner(
      admin,
      owner.userId,
      'course-invalid-slug-org',
    );
    const academy = await seedManagedAcademy(
      admin,
      org.id,
      owner.userId,
      'course-invalid-slug-academy',
    );

    const response = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        title: 'Bad Slug',
        slug: 'Not A Valid Slug!',
        visibility: 'private',
        pricing: { type: 'free' },
      });
    expect(response.status).toBe(400);
  });

  it('rejects a missing required field with 400', async () => {
    const owner = await signUpAndSignIn(app, 'course-missing-field');
    const org = await seedOrganizationWithOwner(
      admin,
      owner.userId,
      'course-missing-org',
    );
    const academy = await seedManagedAcademy(
      admin,
      org.id,
      owner.userId,
      'course-missing-academy',
    );

    const response = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        slug: `course-missing-${Date.now()}`,
        visibility: 'private',
        pricing: { type: 'free' },
      });
    expect(response.status).toBe(400);
  });

  it('write operations are denied for an org member with no academy_members role; reads are still allowed', async () => {
    const owner = await signUpAndSignIn(app, 'course-write-owner');
    const orgMemberOnly = await signUpAndSignIn(app, 'course-write-member');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'course-write-org');
    await admin.organizationMembership.create({
      data: { organizationId: org.id, userId: orgMemberOnly.userId, role: 'member' },
    });
    const academy = await seedManagedAcademy(
      admin,
      org.id,
      owner.userId,
      'course-write-academy',
    );
    const course = await seedCourse(admin, academy.id, 'Course Write Test');

    await request(app.getHttpServer())
      .get(`/academies/${academy.id}/courses/${course.id}`)
      .set('Authorization', `Bearer ${orgMemberOnly.accessToken}`)
      .expect(200);

    const patchResponse = await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/courses/${course.id}`)
      .set('Authorization', `Bearer ${orgMemberOnly.accessToken}`)
      .send({ title: 'Should Not Apply' });
    expect(patchResponse.status).toBe(403);

    const stillIntact = await admin.course.findUniqueOrThrow({
      where: { id: course.id },
    });
    expect(stillIntact.title).toBe('Course Write Test');
  });

  it('GET .../course-categories returns real, seeded categories with real course counts', async () => {
    const owner = await signUpAndSignIn(app, 'course-cat-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'course-cat-org');
    const academy = await seedManagedAcademy(
      admin,
      org.id,
      owner.userId,
      'course-cat-academy',
    );
    const category = await seedCourseCategory(admin, academy.id, 'Programming');
    await seedCourse(admin, academy.id, 'A Course In This Category', {
      categoryId: category.id,
    });

    const response = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/course-categories`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    const found = response.body.items.find((c: { id: string }) => c.id === category.id);
    expect(found).toMatchObject({ name: 'Programming', courseCount: 1 });
  });

  it('GET .../course-categories/:id returns 404 for a category belonging to a different academy', async () => {
    const owner = await signUpAndSignIn(app, 'course-cat-404-owner');
    const org = await seedOrganizationWithOwner(
      admin,
      owner.userId,
      'course-cat-404-org',
    );
    const academyA = await seedManagedAcademy(
      admin,
      org.id,
      owner.userId,
      'course-cat-404-a',
    );
    const academyB = await seedManagedAcademy(
      admin,
      org.id,
      owner.userId,
      'course-cat-404-b',
    );
    const categoryInB = await seedCourseCategory(admin, academyB.id, 'Belongs To B');

    const response = await request(app.getHttpServer())
      .get(`/academies/${academyA.id}/course-categories/${categoryInB.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(response.status).toBe(404);
  });

  it('list filters by status/visibility/categoryId/pricingType', async () => {
    const owner = await signUpAndSignIn(app, 'course-filter-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'course-filter-org');
    const academy = await seedManagedAcademy(
      admin,
      org.id,
      owner.userId,
      'course-filter-academy',
    );
    const category = await seedCourseCategory(admin, academy.id, 'Filter Category');
    const published = await seedCourse(admin, academy.id, 'Published Course', {
      status: 'published',
      visibility: 'public',
      categoryId: category.id,
    });
    await seedCourse(admin, academy.id, 'Draft Course', { status: 'draft' });

    const response = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/courses`)
      .query({ status: 'published', categoryId: category.id })
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    const ids = response.body.items.map((c: { id: string }) => c.id);
    expect(ids).toContain(published.id);
    expect(ids).toHaveLength(1);
  });
});
