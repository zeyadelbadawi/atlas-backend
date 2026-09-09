/**
 * Phase 9 (Student & Instructor Experience Polish) authorization suite —
 * P9-AUTH-001..012, one per scenario the phase's own instructions require,
 * in their stated order:
 *
 *   001  Instructor -> Academy Overview API      -> denied
 *   002  Instructor -> Website API               -> denied
 *   003  Instructor -> Blog (authoring) API      -> denied
 *   004  Instructor -> Academy Members API       -> denied
 *   005  Student    -> Academy Members API       -> denied
 *   006  Student    -> another student's results -> not exposed
 *   007  Student    -> another Academy's results -> not exposed
 *   008  Client Owner -> own Academy analytics   -> allowed
 *   009  Client Owner -> another Academy's       -> denied
 *   010  Manager    -> analytics outside academy -> denied
 *   011  Existing Owner flows still work
 *   012  Instructor's own course-scoped teaching surface still works
 *
 * Exercised through the real HTTP surface against real Postgres/Redis,
 * following the same per-phase pattern as the Phase 8 suite.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedAcademyStudent,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedCourseInstructor,
  seedEnrollment,
  seedOrganizationWithOwner,
  seedQuiz,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';
import {
  ORGANIZATION_INSTRUCTOR_PERMISSIONS,
  ORGANIZATION_MANAGER_PERMISSIONS,
} from '../src/tenancy/constants/organization-permissions.constants';

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

describe('Phase 9 instructor/student/analytics authorization (e2e) — P9-AUTH-001..012', () => {
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

  /** An academy with a real owner, plus a real Instructor holding the exact permission set `AcademiesService.addInstructor` grants. */
  async function seedAcademyWithInstructor(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const instructor = await signUpAndSignIn(app, `${label}-instructor`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');

    await admin.organizationMembership.create({
      data: {
        organizationId: org.id,
        userId: instructor.userId,
        role: 'instructor',
        permissions: [...ORGANIZATION_INSTRUCTOR_PERMISSIONS],
      },
    });
    await seedAcademyMember(admin, academy.id, instructor.userId, 'instructor');

    return { owner, instructor, org, academy };
  }

  // -------------------------------------------------------------------
  // Instructor must not reach the three previously-leaking surfaces.
  // -------------------------------------------------------------------

  it('P9-AUTH-001: Instructor is denied the Academy Overview API', async () => {
    const { instructor, academy } = await seedAcademyWithInstructor('p9a001');

    const response = await request(app.getHttpServer())
      .get(`/academies/${academy.id}`)
      .set('Authorization', `Bearer ${instructor.accessToken}`);
    expect(response.status).toBe(403);
    expect(response.body.error?.kind).not.toBe('notFound');
  });

  it('P9-AUTH-002: Instructor is denied the Website API', async () => {
    const { instructor, academy } = await seedAcademyWithInstructor('p9a002');

    const configuration = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/website/configuration`)
      .set('Authorization', `Bearer ${instructor.accessToken}`);
    expect(configuration.status).toBe(403);

    const pages = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/website/pages`)
      .set('Authorization', `Bearer ${instructor.accessToken}`);
    expect(pages.status).toBe(403);

    const faq = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/website/faq-entries`)
      .set('Authorization', `Bearer ${instructor.accessToken}`);
    expect(faq.status).toBe(403);
  });

  it('P9-AUTH-003: Instructor is denied Blog authoring', async () => {
    const { instructor } = await seedAcademyWithInstructor('p9a003');

    const response = await request(app.getHttpServer())
      .post('/blog-posts')
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .send({
        title: 'P9 instructor post',
        slug: `p9a003-${Date.now()}`,
        content: 'Should never be created.',
      });
    expect(response.status).toBe(403);

    const posts = await admin.blogPost.findMany({
      where: { authorId: instructor.userId },
    });
    expect(posts).toHaveLength(0);
  });

  it('P9-AUTH-004: Instructor is denied the Academy Members API', async () => {
    const { owner, instructor, academy } = await seedAcademyWithInstructor('p9a004');

    const response = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/members`)
      .set('Authorization', `Bearer ${instructor.accessToken}`);
    expect(response.status).toBe(403);
    // No member data of any shape came back.
    expect(response.body.items).toBeUndefined();

    // The owner still can — the endpoint is restricted, not broken.
    const ownerView = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/members`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(Array.isArray(ownerView.body.items)).toBe(true);
  });

  it('P9-AUTH-005: Student is denied the Academy Members API', async () => {
    const { academy } = await seedAcademyWithInstructor('p9a005');
    const student = await signUpAndSignIn(app, 'p9a005-student');
    // A real Student of that academy — an `academy_students` row, and
    // deliberately NO organization membership, which is exactly why the
    // academy guard refuses them one layer before the role check.
    await seedAcademyStudent(admin, academy.id, student.userId);

    const response = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/members`)
      .set('Authorization', `Bearer ${student.accessToken}`);
    expect(response.status).toBe(403);
    expect(response.body.items).toBeUndefined();
  });

  // -------------------------------------------------------------------
  // Student results are strictly the student's own.
  // -------------------------------------------------------------------

  it('P9-AUTH-006: a student never sees another student’s results', async () => {
    const { org, academy } = await seedAcademyWithInstructor('p9a006');
    await seedActiveSubscriptionForOrg(admin, org.id, 'p9a006');
    const course = await seedCourse(admin, academy.id, 'p9a006-course', {
      // Students may only read published+public courses — the one
      // course RLS path they have. A draft fixture would be an unrealistic
      // enrolment, not a stricter test.
      status: 'published',
      visibility: 'public',
    });

    const studentA = await signUpAndSignIn(app, 'p9a006-a');
    const studentB = await signUpAndSignIn(app, 'p9a006-b');
    await seedAcademyStudent(admin, academy.id, studentA.userId);
    await seedAcademyStudent(admin, academy.id, studentB.userId);
    await seedEnrollment(admin, studentA.userId, course.id, academy.id);
    await seedEnrollment(admin, studentB.userId, course.id, academy.id);

    // A real, scored attempt belonging to student B only.
    const quiz = await seedQuiz(admin, course.id, 'p9a006-quiz', {
      status: 'published',
      passingScore: 50,
    });
    await admin.quizAttempt.create({
      data: {
        quizId: quiz.id,
        studentId: studentB.userId,
        status: 'passed',
        attemptNumber: 1,
        score: 91,
        passed: true,
        submittedAt: new Date(),
      },
    });

    const aView = await request(app.getHttpServer())
      .get('/learning/results')
      .set('Authorization', `Bearer ${studentA.accessToken}`)
      .expect(200);

    // A is enrolled in the same course, but B's attempt is nowhere in it.
    const aQuizResults = (
      aView.body.courses as { quizResults: { score: number }[] }[]
    ).flatMap((course_) => course_.quizResults);
    expect(aQuizResults).toHaveLength(0);
    expect(aView.body.summary.quizzesAttempted).toBe(0);
    // `null`, not 0 — A has no scored attempt, which is a different fact
    // from having averaged zero.
    expect(aView.body.summary.averageQuizScore).toBeNull();
    // B's score appears nowhere in A's response. Asserted against the
    // parsed score fields rather than a substring scan of the whole JSON:
    // "91" also occurs by chance inside random UUIDs, which made an
    // earlier substring form of this check fail on passing isolation.
    expect(aQuizResults.map((result) => result.score)).not.toContain(91);

    // And B genuinely does see their own — the absence above is isolation,
    // not an endpoint that returns nothing to anyone.
    const bView = await request(app.getHttpServer())
      .get('/learning/results')
      .set('Authorization', `Bearer ${studentB.accessToken}`)
      .expect(200);
    expect(bView.body.summary.quizzesAttempted).toBe(1);
    expect(bView.body.summary.averageQuizScore).toBe(91);
  });

  it('P9-AUTH-007: a student never sees another Academy’s results', async () => {
    const first = await seedAcademyWithInstructor('p9a007-first');
    const second = await seedAcademyWithInstructor('p9a007-second');
    const courseA = await seedCourse(admin, first.academy.id, 'p9a007-a', {
      // Students may only read published+public courses — the one
      // course RLS path they have. A draft fixture would be an unrealistic
      // enrolment, not a stricter test.
      status: 'published',
      visibility: 'public',
    });
    const courseB = await seedCourse(admin, second.academy.id, 'p9a007-b', {
      // Students may only read published+public courses — the one
      // course RLS path they have. A draft fixture would be an unrealistic
      // enrolment, not a stricter test.
      status: 'published',
      visibility: 'public',
    });

    const student = await signUpAndSignIn(app, 'p9a007-student');
    await seedAcademyStudent(admin, first.academy.id, student.userId);
    await seedEnrollment(admin, student.userId, courseA.id, first.academy.id);

    const response = await request(app.getHttpServer())
      .get('/learning/results')
      .query({ academyId: first.academy.id })
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);

    const courseIds = (response.body.courses as { courseId: string }[]).map(
      (course) => course.courseId,
    );
    expect(courseIds).toContain(courseA.id);
    expect(courseIds).not.toContain(courseB.id);

    // Asking for the other Academy yields nothing rather than its data.
    const foreign = await request(app.getHttpServer())
      .get('/learning/results')
      .query({ academyId: second.academy.id })
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);
    expect(foreign.body.courses).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // Client Owner / Manager analytics scoping.
  // -------------------------------------------------------------------

  it('P9-AUTH-008/009: a Client Owner sees their own Academy’s analytics and never another Organization’s', async () => {
    const mine = await seedAcademyWithInstructor('p9a008-mine');
    const theirs = await seedAcademyWithInstructor('p9a008-theirs');
    const course = await seedCourse(admin, mine.academy.id, 'p9a008-course', {
      // Students may only read published+public courses — the one
      // course RLS path they have. A draft fixture would be an unrealistic
      // enrolment, not a stricter test.
      status: 'published',
      visibility: 'public',
    });
    const student = await signUpAndSignIn(app, 'p9a008-student');
    await seedAcademyStudent(admin, mine.academy.id, student.userId);
    await seedEnrollment(admin, student.userId, course.id, mine.academy.id);

    // 008 — allowed, and reporting the real enrolment.
    const own = await request(app.getHttpServer())
      .get(`/academies/${mine.academy.id}/student-analytics`)
      .set('Authorization', `Bearer ${mine.owner.accessToken}`)
      .expect(200);
    expect(own.body.scope.academyId).toBe(mine.academy.id);
    expect(own.body.funnel.enrolled).toBe(1);

    // 009 — another Organization's academy is refused outright.
    const foreignAcademy = await request(app.getHttpServer())
      .get(`/academies/${theirs.academy.id}/student-analytics`)
      .set('Authorization', `Bearer ${mine.owner.accessToken}`);
    expect(foreignAcademy.status).toBe(403);

    const foreignOrg = await request(app.getHttpServer())
      .get(`/organizations/${theirs.org.id}/student-analytics`)
      .set('Authorization', `Bearer ${mine.owner.accessToken}`);
    expect(foreignOrg.status).toBe(403);
  });

  it('P9-AUTH-010: a Manager gets no analytics outside their assigned Academy', async () => {
    const owner = await signUpAndSignIn(app, 'p9a010-owner');
    const manager = await signUpAndSignIn(app, 'p9a010-manager');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'p9a010-org');
    const academyA = await seedAcademy(admin, org.id, 'p9a010-a');
    const academyB = await seedAcademy(admin, org.id, 'p9a010-b');
    await seedAcademyMember(admin, academyA.id, owner.userId, 'owner');
    await seedAcademyMember(admin, academyB.id, owner.userId, 'owner');

    await admin.organizationMembership.create({
      data: {
        organizationId: org.id,
        userId: manager.userId,
        role: 'manager',
        permissions: [...ORGANIZATION_MANAGER_PERMISSIONS],
      },
    });
    await seedAcademyMember(admin, academyA.id, manager.userId, 'manager');

    // Their own academy — allowed.
    await request(app.getHttpServer())
      .get(`/academies/${academyA.id}/student-analytics`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    // A sibling academy in the SAME organization — refused.
    const sibling = await request(app.getHttpServer())
      .get(`/academies/${academyB.id}/student-analytics`)
      .set('Authorization', `Bearer ${manager.accessToken}`);
    expect(sibling.status).toBe(403);

    // And the organization-wide rollup — refused.
    const orgWide = await request(app.getHttpServer())
      .get(`/organizations/${org.id}/student-analytics`)
      .set('Authorization', `Bearer ${manager.accessToken}`);
    expect(orgWide.status).toBe(403);
  });

  // -------------------------------------------------------------------
  // Nothing legitimate regressed.
  // -------------------------------------------------------------------

  it('P9-AUTH-011: existing Owner flows still work across all four tightened surfaces', async () => {
    const { owner, org, academy } = await seedAcademyWithInstructor('p9a011');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    await request(app.getHttpServer())
      .get(`/academies/${academy.id}`)
      .set(auth)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/academies/${academy.id}/members`)
      .set(auth)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/academies/${academy.id}/website/configuration`)
      .set(auth)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/organizations/${org.id}/student-analytics`)
      .set(auth)
      .expect(200);
  });

  it('P9-AUTH-012: an Instructor’s own course-scoped teaching surface still works', async () => {
    const { instructor, academy } = await seedAcademyWithInstructor('p9a012');
    const course = await seedCourse(admin, academy.id, 'p9a012-course');
    await seedCourseInstructor(admin, course.id, instructor.userId);
    const auth = { Authorization: `Bearer ${instructor.accessToken}` };

    // The Teaching Dashboard and My Courses are untouched by this phase.
    await request(app.getHttpServer()).get('/instructor/dashboard').set(auth).expect(200);
    const courses = await request(app.getHttpServer())
      .get('/instructor/courses')
      .set(auth)
      .expect(200);
    expect(
      (courses.body.items as { courseId?: string; id?: string }[]).some(
        (row) => row.courseId === course.id || row.id === course.id,
      ),
    ).toBe(true);

    // And their assigned course's own overview still resolves.
    await request(app.getHttpServer())
      .get(`/instructor/courses/${course.id}`)
      .set(auth)
      .expect(200);
  });
});
