/**
 * Instructor <-> Course Assignment — Phase 3 (master plan §22/§23) e2e
 * suite. Exercises the real HTTP surface: the new assign/remove write
 * path (`CoursesController.assignInstructor`/`removeInstructor`) and its
 * immediate, real effect on the pre-existing, unmodified instructor read
 * surface (`InstructorController` — "Teaching Dashboard"/"My Courses",
 * reached here via `GET /instructor/courses` and `GET
 * /instructor/courses/:id`, both already resolving teaching scope from
 * `course_instructors` via `CourseInstructorsRepository`, untouched by
 * this phase).
 *
 * Every non-owner actor is seeded with BOTH an `organization_memberships`
 * row and an `academy_members` row — mirroring the real, two-row grant
 * `AcademiesService.addManager`/`addInstructor` themselves always write
 * (see their doc comments) — so `AcademyScopeGuard`'s organization-
 * membership gate is satisfied for the right reason, and a 403/404 in
 * these tests reflects THIS phase's own authorization logic
 * (`CoursesService.assertCanManage` / the target-eligibility check),
 * never an incidental guard rejection one layer up.
 *
 * Test lettering (A-F) matches the roadmap's own Testing Requirements
 * section exactly, for direct traceability.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedAssignment,
  seedCourse,
  seedMembership,
  seedOrganizationWithOwner,
  seedQuiz,
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

describe('Instructor <-> Course Assignment (e2e) — Phase 3', () => {
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

  it('rejects unauthenticated calls', async () => {
    await request(app.getHttpServer())
      .post('/academies/x/courses/y/instructors')
      .send({ userId: 'z' })
      .expect(401);
    await request(app.getHttpServer())
      .delete('/academies/x/courses/y/instructors/z')
      .expect(401);
  }, 20000);

  it('Test A — assign: creates the relationship, and the instructor immediately sees the course and can reach its protected instructor resources', async () => {
    const owner = await signUpAndSignIn(app, 'p23-a-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'p23-a-org');
    const academy = await seedAcademy(admin, org.id, 'p23-a-academy');
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const course = await seedCourse(admin, academy.id, 'P23-A-Course');

    const quiz = await seedQuiz(admin, course.id, 'P23-A-Quiz');
    const assignment = await seedAssignment(admin, course.id, 'P23-A-Assignment');

    const instructor = await signUpAndSignIn(app, 'p23-a-instructor');
    await seedMembership(admin, org.id, instructor.userId, 'instructor');
    await seedAcademyMember(admin, academy.id, instructor.userId, 'instructor');

    // Before assignment: not visible, not reachable.
    await request(app.getHttpServer())
      .get(`/instructor/courses/${course.id}`)
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(404);

    const assigned = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses/${course.id}/instructors`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ userId: instructor.userId })
      .expect(201);
    expect(assigned.body.instructors.map((i: { id: string }) => i.id)).toContain(
      instructor.userId,
    );

    const row = await admin.courseInstructor.findUnique({
      where: { courseId_userId: { courseId: course.id, userId: instructor.userId } },
    });
    expect(row).not.toBeNull();

    const teaching = await request(app.getHttpServer())
      .get('/instructor/courses')
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(200);
    expect(teaching.body.items.map((c: { courseId: string }) => c.courseId)).toContain(
      course.id,
    );

    await request(app.getHttpServer())
      .get(`/instructor/courses/${course.id}`)
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(200);

    // Existing quiz/assignment grading surfaces become reachable — real
    // quiz/assignment rows for THIS course, empty attempt/submission
    // lists (none seeded), but critically a 200: `assertTeachesCourse`
    // (unmodified) now accepts this instructor for this course.
    await request(app.getHttpServer())
      .get(`/instructor/courses/${course.id}/quizzes/${quiz.id}/attempts`)
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/instructor/courses/${course.id}/assignments/${assignment.id}/submissions`)
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(200);
  }, 20000);

  it('Test B — remove: deletes the relationship and immediately revokes access', async () => {
    const owner = await signUpAndSignIn(app, 'p23-b-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'p23-b-org');
    const academy = await seedAcademy(admin, org.id, 'p23-b-academy');
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const course = await seedCourse(admin, academy.id, 'P23-B-Course');

    const instructor = await signUpAndSignIn(app, 'p23-b-instructor');
    await seedMembership(admin, org.id, instructor.userId, 'instructor');
    await seedAcademyMember(admin, academy.id, instructor.userId, 'instructor');

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses/${course.id}/instructors`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ userId: instructor.userId })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/instructor/courses/${course.id}`)
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/academies/${academy.id}/courses/${course.id}/instructors/${instructor.userId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(204);

    const row = await admin.courseInstructor.findUnique({
      where: { courseId_userId: { courseId: course.id, userId: instructor.userId } },
    });
    expect(row).toBeNull();

    await request(app.getHttpServer())
      .get(`/instructor/courses/${course.id}`)
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(404);

    const teaching = await request(app.getHttpServer())
      .get('/instructor/courses')
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(200);
    expect(teaching.body.items.map((c: { courseId: string }) => c.courseId)).not.toContain(
      course.id,
    );

    // Removing twice is a genuine 404 (no row to remove), not a silent success.
    await request(app.getHttpServer())
      .delete(`/academies/${academy.id}/courses/${course.id}/instructors/${instructor.userId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(404);
  }, 20000);

  it('Test C — cross-course isolation: assigned to Course A only, Course B stays inaccessible via direct API', async () => {
    const owner = await signUpAndSignIn(app, 'p23-c-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'p23-c-org');
    const academy = await seedAcademy(admin, org.id, 'p23-c-academy');
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const courseA = await seedCourse(admin, academy.id, 'P23-C-Course-A');
    const courseB = await seedCourse(admin, academy.id, 'P23-C-Course-B');

    const instructor = await signUpAndSignIn(app, 'p23-c-instructor');
    await seedMembership(admin, org.id, instructor.userId, 'instructor');
    await seedAcademyMember(admin, academy.id, instructor.userId, 'instructor');

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses/${courseA.id}/instructors`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ userId: instructor.userId })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/instructor/courses/${courseA.id}`)
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/instructor/courses/${courseB.id}`)
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(404);
  }, 20000);

  it('Test D — cross-academy isolation: an instructor from Academy B cannot be assigned to a Course in Academy A, and a Manager from Academy B cannot manipulate it', async () => {
    const owner = await signUpAndSignIn(app, 'p23-d-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'p23-d-org');
    const academyA = await seedAcademy(admin, org.id, 'p23-d-academy-a');
    await seedAcademyMember(admin, academyA.id, owner.userId, 'owner');
    const courseA = await seedCourse(admin, academyA.id, 'P23-D-Course-A');

    const academyB = await seedAcademy(admin, org.id, 'p23-d-academy-b');
    await seedAcademyMember(admin, academyB.id, owner.userId, 'owner');

    const instructorB = await signUpAndSignIn(app, 'p23-d-instructor-b');
    await seedMembership(admin, org.id, instructorB.userId, 'instructor');
    await seedAcademyMember(admin, academyB.id, instructorB.userId, 'instructor');

    // Instructor B belongs only to Academy B — ineligible for a Course in Academy A.
    await request(app.getHttpServer())
      .post(`/academies/${academyA.id}/courses/${courseA.id}/instructors`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ userId: instructorB.userId })
      .expect(404);

    const row = await admin.courseInstructor.findUnique({
      where: { courseId_userId: { courseId: courseA.id, userId: instructorB.userId } },
    });
    expect(row).toBeNull();

    // A Manager whose ONLY academy membership is Academy B cannot manage Course A's instructors.
    const managerB = await signUpAndSignIn(app, 'p23-d-manager-b');
    await seedMembership(admin, org.id, managerB.userId, 'manager');
    await seedAcademyMember(admin, academyB.id, managerB.userId, 'manager');
    const instructorA = await signUpAndSignIn(app, 'p23-d-instructor-a');
    await seedMembership(admin, org.id, instructorA.userId, 'instructor');
    await seedAcademyMember(admin, academyA.id, instructorA.userId, 'instructor');

    await request(app.getHttpServer())
      .post(`/academies/${academyA.id}/courses/${courseA.id}/instructors`)
      .set('Authorization', `Bearer ${managerB.accessToken}`)
      .send({ userId: instructorA.userId })
      .expect(403);
  }, 20000);

  it('Test E — multi-instructor: both assigned instructors have equal, independent access', async () => {
    const owner = await signUpAndSignIn(app, 'p23-e-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'p23-e-org');
    const academy = await seedAcademy(admin, org.id, 'p23-e-academy');
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const course = await seedCourse(admin, academy.id, 'P23-E-Course');

    const instructorA = await signUpAndSignIn(app, 'p23-e-instructor-a');
    await seedMembership(admin, org.id, instructorA.userId, 'instructor');
    await seedAcademyMember(admin, academy.id, instructorA.userId, 'instructor');
    const instructorB = await signUpAndSignIn(app, 'p23-e-instructor-b');
    await seedMembership(admin, org.id, instructorB.userId, 'instructor');
    await seedAcademyMember(admin, academy.id, instructorB.userId, 'instructor');

    const afterFirst = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses/${course.id}/instructors`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ userId: instructorA.userId })
      .expect(201);
    const afterSecond = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses/${course.id}/instructors`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ userId: instructorB.userId })
      .expect(201);

    const ids = afterSecond.body.instructors.map((i: { id: string }) => i.id);
    expect(ids).toContain(instructorA.userId);
    expect(ids).toContain(instructorB.userId);
    // No rank/order field on either summary — both rows carry the exact
    // same shape (`id`/`name`/`avatar`), matching `afterFirst`'s shape too.
    expect(Object.keys(afterFirst.body.instructors[0]).sort()).toEqual(
      Object.keys(afterSecond.body.instructors[0]).sort(),
    );

    await request(app.getHttpServer())
      .get(`/instructor/courses/${course.id}`)
      .set('Authorization', `Bearer ${instructorA.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/instructor/courses/${course.id}`)
      .set('Authorization', `Bearer ${instructorB.accessToken}`)
      .expect(200);
  }, 20000);

  it('Test F — Academy roster membership alone does not grant course access (regression guard for the CORE RULE)', async () => {
    const owner = await signUpAndSignIn(app, 'p23-f-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'p23-f-org');
    const academy = await seedAcademy(admin, org.id, 'p23-f-academy');
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const course = await seedCourse(admin, academy.id, 'P23-F-Course');

    const instructorC = await signUpAndSignIn(app, 'p23-f-instructor-c');
    // Added to the Academy instructor roster directly — mirrors what
    // `AcademiesService.addInstructor` (`POST /academies/:id/instructors`)
    // itself writes; never assigned to any course.
    await seedMembership(admin, org.id, instructorC.userId, 'instructor');
    await seedAcademyMember(admin, academy.id, instructorC.userId, 'instructor');

    const row = await admin.courseInstructor.findUnique({
      where: { courseId_userId: { courseId: course.id, userId: instructorC.userId } },
    });
    expect(row).toBeNull();

    await request(app.getHttpServer())
      .get(`/instructor/courses/${course.id}`)
      .set('Authorization', `Bearer ${instructorC.accessToken}`)
      .expect(404);
    const teaching = await request(app.getHttpServer())
      .get('/instructor/courses')
      .set('Authorization', `Bearer ${instructorC.accessToken}`)
      .expect(200);
    expect(teaching.body.items).toHaveLength(0);
  }, 20000);

  it('rejects assigning a non-instructor Academy member (e.g. a manager) as a course instructor', async () => {
    const owner = await signUpAndSignIn(app, 'p23-g-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'p23-g-org');
    const academy = await seedAcademy(admin, org.id, 'p23-g-academy');
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const course = await seedCourse(admin, academy.id, 'P23-G-Course');

    const manager = await signUpAndSignIn(app, 'p23-g-manager');
    await seedMembership(admin, org.id, manager.userId, 'manager');
    await seedAcademyMember(admin, academy.id, manager.userId, 'manager');

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses/${course.id}/instructors`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ userId: manager.userId })
      .expect(404);
  }, 20000);

  it('rejects a duplicate assignment (already assigned) with 409', async () => {
    const owner = await signUpAndSignIn(app, 'p23-h-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'p23-h-org');
    const academy = await seedAcademy(admin, org.id, 'p23-h-academy');
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const course = await seedCourse(admin, academy.id, 'P23-H-Course');

    const instructor = await signUpAndSignIn(app, 'p23-h-instructor');
    await seedMembership(admin, org.id, instructor.userId, 'instructor');
    await seedAcademyMember(admin, academy.id, instructor.userId, 'instructor');

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses/${course.id}/instructors`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ userId: instructor.userId })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses/${course.id}/instructors`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ userId: instructor.userId })
      .expect(409);
  }, 20000);

  it('an Academy instructor (not owner/administrator/manager) cannot assign other instructors', async () => {
    const owner = await signUpAndSignIn(app, 'p23-i-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'p23-i-org');
    const academy = await seedAcademy(admin, org.id, 'p23-i-academy');
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const course = await seedCourse(admin, academy.id, 'P23-I-Course');

    const instructor = await signUpAndSignIn(app, 'p23-i-instructor');
    await seedMembership(admin, org.id, instructor.userId, 'instructor');
    await seedAcademyMember(admin, academy.id, instructor.userId, 'instructor');
    const otherInstructor = await signUpAndSignIn(app, 'p23-i-instructor-2');
    await seedMembership(admin, org.id, otherInstructor.userId, 'instructor');
    await seedAcademyMember(admin, academy.id, otherInstructor.userId, 'instructor');

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses/${course.id}/instructors`)
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .send({ userId: otherInstructor.userId })
      .expect(403);
  }, 20000);
});
