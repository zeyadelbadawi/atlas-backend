/**
 * Course Management tenant-isolation suite — P5-TENANT-001..010 (master
 * plan §18/§21 Phase P5 §13), extending the permanent tenant-isolation
 * suite established in `tenant-isolation.e2e-spec.ts` (P2),
 * `academies-tenant-isolation.e2e-spec.ts` (P3), and
 * `tenant-subscription-isolation.e2e-spec.ts` (P4) — one file per phase,
 * same pattern. Exercised through the real HTTP surface; scenario 10 (the
 * pure DB-level RLS proof, independent of application guards) lives in
 * `rls-courses.e2e-spec.ts`, cross-referenced below rather than duplicated.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedCourse,
  seedCourseCategory,
  seedCourseInstructor,
  seedCourseLesson,
  seedCourseSection,
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

describe('Course Management tenant isolation (e2e) — P5-TENANT-001..010', () => {
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

  it('P5-TENANT-001: Academy A (org1) cannot read a Course belonging to Academy B (org2)', async () => {
    const userA = await signUpAndSignIn(app, 'p5t001-userA');
    const userB = await signUpAndSignIn(app, 'p5t001-userB');
    const org1 = await seedOrganizationWithOwner(admin, userA.userId, 'p5t001-org1');
    const org2 = await seedOrganizationWithOwner(admin, userB.userId, 'p5t001-org2');
    const academyA = await seedManagedAcademy(admin, org1.id, userA.userId, 'p5t001-a1');
    const academyB = await seedManagedAcademy(admin, org2.id, userB.userId, 'p5t001-b1');
    const courseB = await seedCourse(admin, academyB.id, 'p5t001-course-b');

    // Direct id, correct academy-in-URL, but the course belongs elsewhere.
    const response = await request(app.getHttpServer())
      .get(`/academies/${academyA.id}/courses/${courseB.id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`);
    expect(response.status).toBe(404);

    // Also denied outright at the academy-scope level.
    const crossAcademy = await request(app.getHttpServer())
      .get(`/academies/${academyB.id}/courses/${courseB.id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`);
    expect(crossAcademy.status).toBe(403);
  });

  it('P5-TENANT-002: Academy A cannot modify a Course belonging to Academy B', async () => {
    const userA = await signUpAndSignIn(app, 'p5t002-userA');
    const userB = await signUpAndSignIn(app, 'p5t002-userB');
    const org1 = await seedOrganizationWithOwner(admin, userA.userId, 'p5t002-org1');
    const org2 = await seedOrganizationWithOwner(admin, userB.userId, 'p5t002-org2');
    const academyA = await seedManagedAcademy(admin, org1.id, userA.userId, 'p5t002-a1');
    const academyB = await seedManagedAcademy(admin, org2.id, userB.userId, 'p5t002-b1');
    const courseB = await seedCourse(admin, academyB.id, 'p5t002-course-b');

    const response = await request(app.getHttpServer())
      .patch(`/academies/${academyA.id}/courses/${courseB.id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ title: 'Hijacked' });
    expect(response.status).toBe(404);

    const stillIntact = await admin.course.findUniqueOrThrow({
      where: { id: courseB.id },
    });
    expect(stillIntact.title).toBe(courseB.title);
  });

  it('P5-TENANT-003: Academy A cannot archive (DELETE) a Course belonging to Academy B', async () => {
    const userA = await signUpAndSignIn(app, 'p5t003-userA');
    const userB = await signUpAndSignIn(app, 'p5t003-userB');
    const org1 = await seedOrganizationWithOwner(admin, userA.userId, 'p5t003-org1');
    const org2 = await seedOrganizationWithOwner(admin, userB.userId, 'p5t003-org2');
    const academyA = await seedManagedAcademy(admin, org1.id, userA.userId, 'p5t003-a1');
    const academyB = await seedManagedAcademy(admin, org2.id, userB.userId, 'p5t003-b1');
    const courseB = await seedCourse(admin, academyB.id, 'p5t003-course-b');

    const response = await request(app.getHttpServer())
      .delete(`/academies/${academyA.id}/courses/${courseB.id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`);
    expect(response.status).toBe(404);

    const stillIntact = await admin.course.findUniqueOrThrow({
      where: { id: courseB.id },
    });
    expect(stillIntact.status).toBe('draft');
  });

  it('P5-TENANT-004: Course section access cannot cross Academy boundaries', async () => {
    const userA = await signUpAndSignIn(app, 'p5t004-userA');
    const userB = await signUpAndSignIn(app, 'p5t004-userB');
    const org1 = await seedOrganizationWithOwner(admin, userA.userId, 'p5t004-org1');
    const org2 = await seedOrganizationWithOwner(admin, userB.userId, 'p5t004-org2');
    const academyA = await seedManagedAcademy(admin, org1.id, userA.userId, 'p5t004-a1');
    const academyB = await seedManagedAcademy(admin, org2.id, userB.userId, 'p5t004-b1');
    const courseA = await seedCourse(admin, academyA.id, 'p5t004-course-a');
    const courseB = await seedCourse(admin, academyB.id, 'p5t004-course-b');
    const sectionB = await seedCourseSection(admin, courseB.id, 'Section in B', 0);

    // Same academy the caller belongs to, own course — but section belongs elsewhere.
    const response = await request(app.getHttpServer())
      .get(`/academies/${academyA.id}/courses/${courseA.id}/sections`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(200);
    expect(response.body.items.map((s: { id: string }) => s.id)).not.toContain(
      sectionB.id,
    );

    const patchAttempt = await request(app.getHttpServer())
      .patch(`/academies/${academyA.id}/courses/${courseA.id}/sections/${sectionB.id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ title: 'Hijacked' });
    expect(patchAttempt.status).toBe(404);
  });

  it('P5-TENANT-005: Course lesson access cannot cross Academy boundaries', async () => {
    const userA = await signUpAndSignIn(app, 'p5t005-userA');
    const userB = await signUpAndSignIn(app, 'p5t005-userB');
    const org1 = await seedOrganizationWithOwner(admin, userA.userId, 'p5t005-org1');
    const org2 = await seedOrganizationWithOwner(admin, userB.userId, 'p5t005-org2');
    const academyA = await seedManagedAcademy(admin, org1.id, userA.userId, 'p5t005-a1');
    const academyB = await seedManagedAcademy(admin, org2.id, userB.userId, 'p5t005-b1');
    const courseA = await seedCourse(admin, academyA.id, 'p5t005-course-a');
    const sectionA = await seedCourseSection(admin, courseA.id, 'Section A', 0);
    const courseB = await seedCourse(admin, academyB.id, 'p5t005-course-b');
    const sectionB = await seedCourseSection(admin, courseB.id, 'Section B', 0);
    const lessonB = await seedCourseLesson(
      admin,
      sectionB.id,
      courseB.id,
      'Lesson in B',
      0,
    );

    const response = await request(app.getHttpServer())
      .patch(
        `/academies/${academyA.id}/courses/${courseA.id}/sections/${sectionA.id}/lessons/${lessonB.id}`,
      )
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ title: 'Hijacked' });
    expect(response.status).toBe(404);

    const deleteResponse = await request(app.getHttpServer())
      .delete(
        `/academies/${academyA.id}/courses/${courseA.id}/sections/${sectionA.id}/lessons/${lessonB.id}`,
      )
      .set('Authorization', `Bearer ${userA.accessToken}`);
    expect(deleteResponse.status).toBe(404);

    const stillExists = await admin.courseLesson.findUnique({
      where: { id: lessonB.id },
    });
    expect(stillExists).not.toBeNull();
  });

  it('P5-TENANT-006: Course category access cannot cross Academy boundaries', async () => {
    const userA = await signUpAndSignIn(app, 'p5t006-userA');
    const userB = await signUpAndSignIn(app, 'p5t006-userB');
    const org1 = await seedOrganizationWithOwner(admin, userA.userId, 'p5t006-org1');
    const org2 = await seedOrganizationWithOwner(admin, userB.userId, 'p5t006-org2');
    const academyA = await seedManagedAcademy(admin, org1.id, userA.userId, 'p5t006-a1');
    const academyB = await seedManagedAcademy(admin, org2.id, userB.userId, 'p5t006-b1');
    const categoryB = await seedCourseCategory(admin, academyB.id, 'Category B');

    const list = await request(app.getHttpServer())
      .get(`/academies/${academyA.id}/course-categories`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(200);
    expect(list.body.items.map((c: { id: string }) => c.id)).not.toContain(categoryB.id);

    const detail = await request(app.getHttpServer())
      .get(`/academies/${academyA.id}/course-categories/${categoryB.id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`);
    expect(detail.status).toBe(404);
  });

  it("P5-TENANT-007: a course_instructor row for a course in Academy B never surfaces in Academy A's data", async () => {
    const userA = await signUpAndSignIn(app, 'p5t007-userA');
    const userB = await signUpAndSignIn(app, 'p5t007-userB');
    const instructor = await signUpAndSignIn(app, 'p5t007-instructor');
    const org1 = await seedOrganizationWithOwner(admin, userA.userId, 'p5t007-org1');
    const org2 = await seedOrganizationWithOwner(admin, userB.userId, 'p5t007-org2');
    const academyA = await seedManagedAcademy(admin, org1.id, userA.userId, 'p5t007-a1');
    const academyB = await seedManagedAcademy(admin, org2.id, userB.userId, 'p5t007-b1');
    const courseA = await seedCourse(admin, academyA.id, 'p5t007-course-a');
    const courseB = await seedCourse(admin, academyB.id, 'p5t007-course-b');
    await seedCourseInstructor(admin, courseB.id, instructor.userId);

    const responseA = await request(app.getHttpServer())
      .get(`/academies/${academyA.id}/courses/${courseA.id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(200);
    expect(responseA.body.instructors).toEqual([]);

    const responseB = await request(app.getHttpServer())
      .get(`/academies/${academyB.id}/courses/${courseB.id}`)
      .set('Authorization', `Bearer ${userB.accessToken}`)
      .expect(200);
    expect(responseB.body.instructors).toHaveLength(1);
    expect(responseB.body.instructors[0].id).toBe(instructor.userId);
  });

  it("P5-TENANT-008: concurrent requests for different academies' courses never cross-contaminate", async () => {
    const userA = await signUpAndSignIn(app, 'p5t008-userA');
    const userB = await signUpAndSignIn(app, 'p5t008-userB');
    const orgA = await seedOrganizationWithOwner(admin, userA.userId, 'p5t008-orgA');
    const orgB = await seedOrganizationWithOwner(admin, userB.userId, 'p5t008-orgB');
    const academyA = await seedManagedAcademy(admin, orgA.id, userA.userId, 'p5t008-a');
    const academyB = await seedManagedAcademy(admin, orgB.id, userB.userId, 'p5t008-b');
    const courseA = await seedCourse(admin, academyA.id, 'p5t008-course-a');
    const courseB = await seedCourse(admin, academyB.id, 'p5t008-course-b');

    const ROUNDS = 15;
    const requests = Array.from({ length: ROUNDS }, (_, i) =>
      i % 2 === 0
        ? request(app.getHttpServer())
            .get(`/academies/${academyA.id}/courses/${courseA.id}`)
            .set('Authorization', `Bearer ${userA.accessToken}`)
            .then((res) => ({ expected: courseA.id, res }))
        : request(app.getHttpServer())
            .get(`/academies/${academyB.id}/courses/${courseB.id}`)
            .set('Authorization', `Bearer ${userB.accessToken}`)
            .then((res) => ({ expected: courseB.id, res })),
    );

    const results = await Promise.all(requests);
    for (const { expected, res } of results) {
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(expected);
    }
  });

  it('P5-TENANT-009: missing tenant context (unauthenticated, and authenticated-but-not-a-member) both fail closed', async () => {
    const owner = await signUpAndSignIn(app, 'p5t009-owner');
    const outsider = await signUpAndSignIn(app, 'p5t009-outsider');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'p5t009-org');
    const academy = await seedManagedAcademy(
      admin,
      org.id,
      owner.userId,
      'p5t009-academy',
    );
    const course = await seedCourse(admin, academy.id, 'p5t009-course');

    const unauthenticated = await request(app.getHttpServer()).get(
      `/academies/${academy.id}/courses/${course.id}`,
    );
    expect(unauthenticated.status).toBe(401);

    const notAMember = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/courses/${course.id}`)
      .set('Authorization', `Bearer ${outsider.accessToken}`);
    expect(notAMember.status).toBe(403);
  });

  it('P5-TENANT-010: sanity — a random, never-seeded course id under a real academy is also rejected (404, not a crash); see rls-courses.e2e-spec.ts for the independent DB-level proof', async () => {
    const owner = await signUpAndSignIn(app, 'p5t010-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'p5t010-org');
    const academy = await seedManagedAcademy(
      admin,
      org.id,
      owner.userId,
      'p5t010-academy',
    );

    const response = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/courses/${randomUUID()}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(response.status).toBe(404);
  });
});
