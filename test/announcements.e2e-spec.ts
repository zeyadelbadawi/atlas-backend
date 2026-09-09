/**
 * Announcements e2e suite (master plan §21 Phase P7, §5.5, §10). Exercises
 * `AnnouncementsController`'s real HTTP surface — the visible feed
 * (`GET /announcements`) and course-scoped authoring (`courses/:id/
 * announcements/*`), matching `AnnouncementService`'s (frontend) real
 * contract exactly.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyStudent,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

async function makePlatformOwner(admin: PrismaClient, userId: string): Promise<void> {
  await admin.user.update({ where: { id: userId }, data: { isPlatformOwner: true } });
}

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

describe('Announcements (e2e)', () => {
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

  async function seedManagedCourse(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const course = await seedCourse(admin, academy.id, `${label}-course-${Date.now()}`, {
      status: 'published',
      visibility: 'public',
    });
    return { owner, org, academy, course };
  }

  it('the academy owner creates, publishes, and lists a course announcement; a plain org member cannot create one', async () => {
    const { owner, course } = await seedManagedCourse('ann-crud');
    const created = await request(app.getHttpServer())
      .post(`/courses/${course.id}/announcements`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Welcome!', body: 'Glad to have you.' })
      .expect(201);
    expect(created.body.status).toBe('draft');
    expect(created.body.audience).toBe('course');

    const published = await request(app.getHttpServer())
      .post(`/courses/${course.id}/announcements/${created.body.id}/publish`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);
    expect(published.body.status).toBe('published');
    expect(published.body.publishedAt).toBeTruthy();

    const list = await request(app.getHttpServer())
      .get(`/courses/${course.id}/announcements`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(list.body.items.map((a: { id: string }) => a.id)).toContain(created.body.id);

    // A plain org member with no academy role at all cannot author.
    const outsider = await signUpAndSignIn(app, 'ann-crud-outsider');
    await request(app.getHttpServer())
      .post(`/courses/${course.id}/announcements`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .send({ title: 'Hijacked', body: 'Should not work.' })
      .expect(403);
  });

  it('a published course announcement is visible in the feed to an enrolled student, and archiving removes it from further public visibility', async () => {
    const { owner, academy, course } = await seedManagedCourse('ann-feed');
    const student = await signUpAndSignIn(app, 'ann-feed-student');
    await seedAcademyStudent(admin, academy.id, student.userId);
    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ courseId: course.id })
      .expect(201);

    const created = await request(app.getHttpServer())
      .post(`/courses/${course.id}/announcements`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Class starts Monday', body: 'See you there.' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/courses/${course.id}/announcements/${created.body.id}/publish`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);

    const feed = await request(app.getHttpServer())
      .get('/announcements')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);
    expect(feed.body.items.map((a: { id: string }) => a.id)).toContain(created.body.id);

    await request(app.getHttpServer())
      .post(`/courses/${course.id}/announcements/${created.body.id}/archive`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);

    const feedAfterArchive = await request(app.getHttpServer())
      .get('/announcements')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);
    expect(feedAfterArchive.body.items.map((a: { id: string }) => a.id)).not.toContain(
      created.body.id,
    );
  });

  it('a draft course announcement never appears in a student feed before publishing', async () => {
    const { owner, academy, course } = await seedManagedCourse('ann-draft-hidden');
    const student = await signUpAndSignIn(app, 'ann-draft-hidden-student');
    await seedAcademyStudent(admin, academy.id, student.userId);
    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ courseId: course.id })
      .expect(201);

    const created = await request(app.getHttpServer())
      .post(`/courses/${course.id}/announcements`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Not yet', body: 'Still drafting.' })
      .expect(201);

    const feed = await request(app.getHttpServer())
      .get('/announcements')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);
    expect(feed.body.items.map((a: { id: string }) => a.id)).not.toContain(
      created.body.id,
    );
  });

  // -------------------------------------------------------------------
  // Phase 6 — academy-wide authoring.
  // -------------------------------------------------------------------

  it('an academy owner creates, publishes, lists, and archives an academy-wide announcement; a plain org member cannot author one, and it appears in an enrolled student feed once published', async () => {
    const { owner, academy, course } = await seedManagedCourse('ann-academy-crud');
    const student = await signUpAndSignIn(app, 'ann-academy-crud-student');
    await seedAcademyStudent(admin, academy.id, student.userId);
    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ courseId: course.id })
      .expect(201);

    const created = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/announcements`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Academy-wide notice', body: 'Applies to everyone.' })
      .expect(201);
    expect(created.body.status).toBe('draft');
    expect(created.body.audience).toBe('academy');

    // A plain org member with no academy role at all cannot author.
    const outsider = await signUpAndSignIn(app, 'ann-academy-crud-outsider');
    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/announcements`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .send({ title: 'Hijacked', body: 'Should not work.' })
      .expect(403);

    const published = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/announcements/${created.body.id}/publish`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);
    expect(published.body.status).toBe('published');

    const list = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/announcements`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(list.body.items.map((a: { id: string }) => a.id)).toContain(created.body.id);

    const feed = await request(app.getHttpServer())
      .get('/announcements')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);
    expect(feed.body.items.map((a: { id: string }) => a.id)).toContain(created.body.id);

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/announcements/${created.body.id}/archive`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);

    const feedAfterArchive = await request(app.getHttpServer())
      .get('/announcements')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);
    expect(feedAfterArchive.body.items.map((a: { id: string }) => a.id)).not.toContain(
      created.body.id,
    );
  });

  it('a manager may author an academy-wide announcement, but a student and an instructor cannot', async () => {
    const { academy } = await seedManagedCourse('ann-academy-roles');
    const manager = await signUpAndSignIn(app, 'ann-academy-roles-manager');
    await seedAcademyMember(admin, academy.id, manager.userId, 'manager');
    const instructor = await signUpAndSignIn(app, 'ann-academy-roles-instructor');
    await seedAcademyMember(admin, academy.id, instructor.userId, 'instructor');
    const student = await signUpAndSignIn(app, 'ann-academy-roles-student');
    await seedAcademyStudent(admin, academy.id, student.userId);

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/announcements`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ title: 'From a manager', body: 'Managers may author.' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/announcements`)
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .send({ title: 'From an instructor', body: 'Should not work.' })
      .expect(403);

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/announcements`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ title: 'From a student', body: 'Should not work.' })
      .expect(403);
  });

  it("one academy cannot author, read, or update another academy's academy-wide announcements", async () => {
    const { owner: ownerA, academy: academyA } =
      await seedManagedCourse('ann-academy-iso-a');
    const { owner: ownerB, academy: academyB } =
      await seedManagedCourse('ann-academy-iso-b');

    const createdA = await request(app.getHttpServer())
      .post(`/academies/${academyA.id}/announcements`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ title: 'Academy A only', body: 'Private to A.' })
      .expect(201);

    // B's owner cannot author into A's academy id.
    await request(app.getHttpServer())
      .post(`/academies/${academyA.id}/announcements`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ title: 'Hijacked from B', body: 'Should not work.' })
      .expect(403);

    // B's owner cannot see A's announcement in B's own management list.
    const listB = await request(app.getHttpServer())
      .get(`/academies/${academyB.id}/announcements`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(200);
    expect(listB.body.items.map((a: { id: string }) => a.id)).not.toContain(
      createdA.body.id,
    );

    // B's owner cannot update A's announcement even by guessing its id.
    await request(app.getHttpServer())
      .patch(`/academies/${academyA.id}/announcements/${createdA.body.id}`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ title: 'Overwritten' })
      .expect(403);
  });

  // -------------------------------------------------------------------
  // Phase 6 — platform-wide authoring.
  // -------------------------------------------------------------------

  it('a platform owner creates, publishes, lists, and archives a platform-wide announcement; a real academy owner (not a platform owner) cannot', async () => {
    const platformOwner = await signUpAndSignIn(app, 'ann-platform-crud-owner');
    await makePlatformOwner(admin, platformOwner.userId);
    const { owner: academyOwner } = await seedManagedCourse('ann-platform-crud-academy');

    await request(app.getHttpServer())
      .post('/platform/announcements')
      .set('Authorization', `Bearer ${academyOwner.accessToken}`)
      .send({ title: 'Hijacked', body: 'Should not work.' })
      .expect(403);

    const created = await request(app.getHttpServer())
      .post('/platform/announcements')
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .send({ title: 'Platform-wide notice', body: 'Applies to all academies.' })
      .expect(201);
    expect(created.body.status).toBe('draft');
    expect(created.body.audience).toBe('platform');

    const published = await request(app.getHttpServer())
      .post(`/platform/announcements/${created.body.id}/publish`)
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .expect(201);
    expect(published.body.status).toBe('published');

    const list = await request(app.getHttpServer())
      .get('/platform/announcements')
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .expect(200);
    expect(list.body.items.map((a: { id: string }) => a.id)).toContain(created.body.id);

    // Visible in the general feed to anyone once published (matches the
    // pre-existing `announcements_platform_select` read policy).
    const feed = await request(app.getHttpServer())
      .get('/announcements')
      .set('Authorization', `Bearer ${academyOwner.accessToken}`)
      .expect(200);
    expect(feed.body.items.map((a: { id: string }) => a.id)).toContain(created.body.id);

    await request(app.getHttpServer())
      .post(`/platform/announcements/${created.body.id}/archive`)
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .expect(201);

    // A real academy owner cannot read the platform-management list either.
    await request(app.getHttpServer())
      .get('/platform/announcements')
      .set('Authorization', `Bearer ${academyOwner.accessToken}`)
      .expect(403);
  });
});
