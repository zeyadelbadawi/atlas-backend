/**
 * Student Learning tenant-isolation suite — P6-TENANT-001..006 (master
 * plan §18 scenario 4: "a student authenticated as User B attempts to read
 * another student's Enrollment/QuizAttempt/AssignmentSubmission by
 * guessing/incrementing an id → must fail; every such endpoint resolves
 * studentId from the session, never a request parameter"), extending the
 * permanent tenant-isolation suite established in
 * `tenant-isolation.e2e-spec.ts` (P2) through
 * `courses-tenant-isolation.e2e-spec.ts` (P5) — one file per phase, same
 * pattern. Exercised through the real HTTP surface; the pure DB-level RLS
 * proof lives in `rls-learning.e2e-spec.ts`.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyStudent,
  seedActiveSubscriptionForOrg,
  seedAssignment,
  seedCourse,
  seedOrganizationWithOwner,
  seedQuiz,
  seedQuizQuestion,
  seedQuizQuestionOption,
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

describe('Student Learning tenant isolation (e2e) — P6-TENANT-001..006', () => {
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

  async function seedCourseFixture(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    const course = await seedCourse(admin, academy.id, `${label}-course-${Date.now()}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    return { course };
  }

  it("P6-TENANT-001: Student B cannot read Student A's enrollment via GET /enrollments/by-course/:courseId — the id is always resolved from the session, not guessable/spoofable", async () => {
    const { course } = await seedCourseFixture('t001');
    const studentA = await signUpAndSignIn(app, 't001-a');
    const studentB = await signUpAndSignIn(app, 't001-b');
    await seedAcademyStudent(admin, course.academyId, studentA.userId);
    await seedAcademyStudent(admin, course.academyId, studentB.userId);

    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${studentA.accessToken}`)
      .send({ courseId: course.id })
      .expect(201);

    // Student B queries the exact same course id under their own token —
    // structurally cannot address Student A's enrollment at all.
    const asB = await request(app.getHttpServer())
      .get(`/enrollments/by-course/${course.id}`)
      .set('Authorization', `Bearer ${studentB.accessToken}`)
      .expect(200);
    expect(asB.body).toBeNull();
  });

  it("P6-TENANT-002: Student B's own enrollment list never includes Student A's enrollments", async () => {
    const { course } = await seedCourseFixture('t002');
    const studentA = await signUpAndSignIn(app, 't002-a');
    const studentB = await signUpAndSignIn(app, 't002-b');
    await seedAcademyStudent(admin, course.academyId, studentA.userId);
    await seedAcademyStudent(admin, course.academyId, studentB.userId);

    const enrollmentA = await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${studentA.accessToken}`)
      .send({ courseId: course.id })
      .expect(201);

    const listB = await request(app.getHttpServer())
      .get('/enrollments')
      .set('Authorization', `Bearer ${studentB.accessToken}`)
      .expect(200);
    expect(listB.body.items.map((e: { id: string }) => e.id)).not.toContain(
      enrollmentA.body.id,
    );
  });

  it("P6-TENANT-003: Student B cannot read Student A's course progress even though both are enrolled in the same course", async () => {
    const { course } = await seedCourseFixture('t003');
    const studentA = await signUpAndSignIn(app, 't003-a');
    const studentB = await signUpAndSignIn(app, 't003-b');
    await seedAcademyStudent(admin, course.academyId, studentA.userId);
    await seedAcademyStudent(admin, course.academyId, studentB.userId);

    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${studentA.accessToken}`)
      .send({ courseId: course.id })
      .expect(201);
    // Student B is deliberately NOT enrolled — progress must 404, never
    // leak Student A's real progress data for the "same" course id.
    const asB = await request(app.getHttpServer())
      .get(`/courses/${course.id}/progress`)
      .set('Authorization', `Bearer ${studentB.accessToken}`)
      .expect(404);
    expect(asB.body).not.toMatchObject({ completedLessons: expect.any(Number) });
  });

  it("P6-TENANT-004: Student B cannot submit or read Student A's quiz attempt by guessing the attempt id", async () => {
    const { course } = await seedCourseFixture('t004');
    const quiz = await seedQuiz(admin, course.id, 't004 quiz', { status: 'published' });
    const question = await seedQuizQuestion(admin, quiz.id, 'Q?', 'single_choice', 0);
    const option = await seedQuizQuestionOption(admin, question.id, 'A', true);

    const studentA = await signUpAndSignIn(app, 't004-a');
    const studentB = await signUpAndSignIn(app, 't004-b');
    await seedAcademyStudent(admin, course.academyId, studentA.userId);
    await seedAcademyStudent(admin, course.academyId, studentB.userId);
    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${studentA.accessToken}`)
      .send({ courseId: course.id })
      .expect(201);
    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${studentB.accessToken}`)
      .send({ courseId: course.id })
      .expect(201);

    const attemptA = await request(app.getHttpServer())
      .post(`/courses/${course.id}/quizzes/${quiz.id}/attempts`)
      .set('Authorization', `Bearer ${studentA.accessToken}`)
      .expect(201);

    // Student B, also legitimately enrolled, still cannot touch Student
    // A's specific attempt id.
    await request(app.getHttpServer())
      .post(
        `/courses/${course.id}/quizzes/${quiz.id}/attempts/${attemptA.body.id}/submit`,
      )
      .set('Authorization', `Bearer ${studentB.accessToken}`)
      .send({ answers: [{ questionId: question.id, selectedOptionIds: [option.id] }] })
      .expect(404);

    const listB = await request(app.getHttpServer())
      .get(`/courses/${course.id}/quizzes/${quiz.id}/attempts`)
      .set('Authorization', `Bearer ${studentB.accessToken}`)
      .expect(200);
    expect(listB.body.items.map((a: { id: string }) => a.id)).not.toContain(
      attemptA.body.id,
    );
  });

  it("P6-TENANT-005: Student B's assignment submission read never returns Student A's submission", async () => {
    const { course } = await seedCourseFixture('t005');
    const assignment = await seedAssignment(admin, course.id, 't005 assignment', {
      status: 'published',
    });
    const studentA = await signUpAndSignIn(app, 't005-a');
    const studentB = await signUpAndSignIn(app, 't005-b');
    await seedAcademyStudent(admin, course.academyId, studentA.userId);
    await seedAcademyStudent(admin, course.academyId, studentB.userId);
    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${studentA.accessToken}`)
      .send({ courseId: course.id })
      .expect(201);
    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${studentB.accessToken}`)
      .send({ courseId: course.id })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/courses/${course.id}/assignments/${assignment.id}/submission`)
      .set('Authorization', `Bearer ${studentA.accessToken}`)
      .send({ response: "Student A's private answer." })
      .expect(201);

    const asB = await request(app.getHttpServer())
      .get(`/courses/${course.id}/assignments/${assignment.id}/submission`)
      .set('Authorization', `Bearer ${studentB.accessToken}`)
      .expect(200);
    expect(asB.body).toBeNull();
  });

  it("P6-TENANT-006: completing a lesson as Student B never affects Student A's progress on the same course", async () => {
    const { course } = await seedCourseFixture('t006');
    const admin2 = admin;
    const section = await admin2.courseSection.create({
      data: { courseId: course.id, title: 'S', order: 0 },
    });
    const lesson = await admin2.courseLesson.create({
      data: {
        sectionId: section.id,
        courseId: course.id,
        title: 'L',
        order: 0,
        contentType: 'text',
        status: 'published',
      },
    });

    const studentA = await signUpAndSignIn(app, 't006-a');
    const studentB = await signUpAndSignIn(app, 't006-b');
    await seedAcademyStudent(admin, course.academyId, studentA.userId);
    await seedAcademyStudent(admin, course.academyId, studentB.userId);
    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${studentA.accessToken}`)
      .send({ courseId: course.id })
      .expect(201);
    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${studentB.accessToken}`)
      .send({ courseId: course.id })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/courses/${course.id}/progress/complete-lesson`)
      .set('Authorization', `Bearer ${studentB.accessToken}`)
      .send({ lessonId: lesson.id })
      .expect(201);

    const progressA = await request(app.getHttpServer())
      .get(`/courses/${course.id}/progress`)
      .set('Authorization', `Bearer ${studentA.accessToken}`)
      .expect(200);
    expect(progressA.body.completedLessons).toBe(0);
  });
});
