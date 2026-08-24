/**
 * Course Discovery — `discoverCourses`/`discoverCourse` (P6, master plan
 * §21). The flat, cross-academy, published-only catalog — deferred out of
 * P5, picked up here. Exercises the real HTTP surface end-to-end.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
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

describe('Course Discovery (e2e)', () => {
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

  it('requires authentication', async () => {
    await request(app.getHttpServer()).get('/courses').expect(401);
  });

  it("lists only published + public courses, never draft/private ones, regardless of the caller's organization membership", async () => {
    const owner = await signUpAndSignIn(app, 'discover-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'discover-org');
    const academy = await seedAcademy(admin, org.id, 'discover-academy');

    const publicPublished = await seedCourse(
      admin,
      academy.id,
      `Discoverable ${Date.now()}`,
      {
        status: 'published',
        visibility: 'public',
      },
    );
    await seedCourse(admin, academy.id, `Draft ${Date.now()}`, {
      status: 'draft',
      visibility: 'public',
    });
    await seedCourse(admin, academy.id, `Private ${Date.now()}`, {
      status: 'published',
      visibility: 'private',
    });

    // A student with zero relationship to `org` — proves discovery is not
    // organization-membership-gated at all, unlike the owner-facing
    // `academies/:id/courses` tree.
    const student = await signUpAndSignIn(app, 'discover-student');

    const list = await request(app.getHttpServer())
      .get('/courses')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);

    const ids = list.body.items.map((c: { id: string }) => c.id);
    expect(ids).toContain(publicPublished.id);
    expect(ids.length).toBe(list.body.items.length);
    for (const course of list.body.items) {
      expect(course.status).toBe('published');
      expect(course.visibility).toBe('public');
    }
  });

  it('a crafted status/visibility filter can never widen discovery to draft/private courses', async () => {
    const owner = await signUpAndSignIn(app, 'discover-widen-owner');
    const org = await seedOrganizationWithOwner(
      admin,
      owner.userId,
      'discover-widen-org',
    );
    const academy = await seedAcademy(admin, org.id, 'discover-widen-academy');
    const draft = await seedCourse(admin, academy.id, `Widen Draft ${Date.now()}`, {
      status: 'draft',
      visibility: 'public',
    });

    const student = await signUpAndSignIn(app, 'discover-widen-student');
    const list = await request(app.getHttpServer())
      .get('/courses')
      .query({ status: 'draft' })
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);

    expect(list.body.items.map((c: { id: string }) => c.id)).not.toContain(draft.id);
  });

  it('discoverCourse returns a published+public course by id alone, from any academy', async () => {
    const owner = await signUpAndSignIn(app, 'discover-single-owner');
    const org = await seedOrganizationWithOwner(
      admin,
      owner.userId,
      'discover-single-org',
    );
    const academy = await seedAcademy(admin, org.id, 'discover-single-academy');
    const course = await seedCourse(admin, academy.id, `Single ${Date.now()}`, {
      status: 'published',
      visibility: 'public',
    });

    const student = await signUpAndSignIn(app, 'discover-single-student');
    const response = await request(app.getHttpServer())
      .get(`/courses/${course.id}`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);
    expect(response.body.id).toBe(course.id);
  });

  it('discoverCourse 404s for a draft course — structurally unreachable, not merely denied', async () => {
    const owner = await signUpAndSignIn(app, 'discover-draft-owner');
    const org = await seedOrganizationWithOwner(
      admin,
      owner.userId,
      'discover-draft-org',
    );
    const academy = await seedAcademy(admin, org.id, 'discover-draft-academy');
    const draft = await seedCourse(admin, academy.id, `Unreachable ${Date.now()}`, {
      status: 'draft',
      visibility: 'public',
    });

    const student = await signUpAndSignIn(app, 'discover-draft-student');
    await request(app.getHttpServer())
      .get(`/courses/${draft.id}`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(404);
  });

  it('discoverCourse 404s for a private course', async () => {
    const owner = await signUpAndSignIn(app, 'discover-private-owner');
    const org = await seedOrganizationWithOwner(
      admin,
      owner.userId,
      'discover-private-org',
    );
    const academy = await seedAcademy(admin, org.id, 'discover-private-academy');
    const priv = await seedCourse(admin, academy.id, `Private Single ${Date.now()}`, {
      status: 'published',
      visibility: 'private',
    });

    const student = await signUpAndSignIn(app, 'discover-private-student');
    await request(app.getHttpServer())
      .get(`/courses/${priv.id}`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(404);
  });
});
