/**
 * Course progress across the whole sequence (2 Oct 2026).
 *
 * A quiz-only course read "0 of 0 lessons completed" and could never be
 * completed: progress counted lessons only, and the completion rule needs
 * something required while quizzes default to optional. Pinned here against
 * the real database:
 *   - every progress read (My Learning, the course progress, the overview)
 *     carries totalItems/completedItems — lessons, quizzes and assignments —
 *     from the moment of enrollment;
 *   - a course without lessons completes when its published quizzes are
 *     passed, with nothing marked required;
 *   - a mixed course keeps optional quizzes optional (lessons still decide),
 *     while its counts include the quiz;
 *   - the public course details read reports the quiz count, not just "0
 *     lessons".
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyStudent,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedCourseLesson,
  seedCourseSection,
  seedOrganizationWithOwner,
  seedQuiz,
  seedQuizQuestion,
  seedQuizQuestionOption,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

describe('Course item progress (e2e)', () => {
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

  async function signUpAndSignIn(label: string) {
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
    return {
      email,
      userId: signIn.body.user.id as string,
      token: signIn.body.accessToken as string,
    };
  }

  /**
   * The learner overview is an Academy-surface read: it needs a session
   * opened on the Academy's own host (password, then the emailed code —
   * read from the local test database's outbox, as launch-stabilization
   * does).
   */
  async function academySession(academyId: string, host: string, email: string) {
    const open = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .set('Host', host)
      .send({ email, password: 'correct-horse-battery', surface: 'academy', academyId })
      .expect(200);
    if (open.body.accessToken) return open.body.accessToken as string;
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    const rows = await admin.$queryRaw<{ values: { code?: string } | null }[]>`
      SELECT "values" FROM "communication_outbox"
      WHERE "recipient_user_id" = ${user.id} AND "key" = 'auth.email.otp'
      ORDER BY "created_at" DESC LIMIT 1
    `;
    const verified = await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .set('Host', host)
      .send({
        challengeId: open.body.challengeId,
        code: rows[0]?.values?.code,
        rememberDevice: false,
        surface: 'academy',
      })
      .expect(200);
    return verified.body.accessToken as string;
  }

  const get = (token: string, url: string) =>
    request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`);
  const post = (token: string, url: string, body: object = {}) =>
    request(app.getHttpServer())
      .post(url)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  async function seedCourseWith(label: string, lessons: number, quizzes: number) {
    const owner = await signUpAndSignIn(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await admin.academy.update({ where: { id: academy.id }, data: { status: 'active' } });
    const host = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.items.test`;
    await admin.domainConnection.create({
      data: { academyId: academy.id, hostname: host, status: 'connected' },
    });
    const course = await seedCourse(admin, academy.id, `${label}-course-${Date.now()}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    if (lessons > 0) {
      const section = await seedCourseSection(admin, course.id, 'Section', 0);
      for (let i = 0; i < lessons; i += 1) {
        await seedCourseLesson(admin, section.id, course.id, `Lesson ${i + 1}`, i, {
          status: 'published',
        });
      }
    }
    const quizList: { id: string; questionId: string; correctId: string }[] = [];
    for (let i = 0; i < quizzes; i += 1) {
      // Optional, as every quiz is until an author marks it required.
      const quiz = await seedQuiz(admin, course.id, `${label} quiz ${i + 1}`, {
        status: 'published',
        passingScore: 50,
      });
      const question = await seedQuizQuestion(admin, quiz.id, '2+2?', 'single_choice', 0);
      const correct = await seedQuizQuestionOption(admin, question.id, '4', true);
      await seedQuizQuestionOption(admin, question.id, '5', false);
      quizList.push({ id: quiz.id, questionId: question.id, correctId: correct.id });
    }
    const student = await signUpAndSignIn(`${label}-student`);
    await seedAcademyStudent(admin, academy.id, student.userId);
    await post(student.token, '/enrollments', { courseId: course.id }).expect(201);
    return { academy, host, course, quizzes: quizList, student };
  }

  async function pass(
    token: string,
    courseId: string,
    quiz: { id: string; questionId: string; correctId: string },
  ) {
    const started = await post(
      token,
      `/courses/${courseId}/quizzes/${quiz.id}/attempts`,
    ).expect(201);
    const submitted = await post(
      token,
      `/courses/${courseId}/quizzes/${quiz.id}/attempts/${started.body.id}/submit`,
      { answers: [{ questionId: quiz.questionId, selectedOptionIds: [quiz.correctId] }] },
    ).expect(201);
    expect(submitted.body.passed).toBe(true);
  }

  async function myEnrollment(token: string, courseId: string) {
    const list = await get(token, '/enrollments').expect(200);
    return (
      list.body.items as { courseId: string; progress?: Record<string, unknown> }[]
    ).find((row) => row.courseId === courseId)!;
  }

  it('a quiz-only course counts its quizzes and completes when they are passed', async () => {
    const { academy, host, course, quizzes, student } = await seedCourseWith(
      'items-quiz',
      0,
      2,
    );

    // From the moment of enrollment: 0 of 2, not 0 of 0.
    let enrollment = await myEnrollment(student.token, course.id);
    expect(enrollment.progress).toMatchObject({
      totalLessons: 0,
      completedLessons: 0,
      totalItems: 2,
      completedItems: 0,
      percentage: 0,
    });

    await pass(student.token, course.id, quizzes[0]);
    const progress = await get(student.token, `/courses/${course.id}/progress`).expect(
      200,
    );
    expect(progress.body).toMatchObject({
      totalItems: 2,
      completedItems: 1,
      percentage: 50,
    });
    expect(progress.body.completionState).not.toBe('completed');

    const academyToken = await academySession(academy.id, host, student.email);
    const overview = await request(app.getHttpServer())
      .get('/learning/overview')
      .set('Host', host)
      .set('Authorization', `Bearer ${academyToken}`)
      .expect(200);
    const card = (
      overview.body.continueLearning as { courseId: string; [key: string]: unknown }[]
    ).find((row) => row.courseId === course.id);
    expect(card).toMatchObject({ totalItems: 2, completedItems: 1, percentage: 50 });

    await pass(student.token, course.id, quizzes[1]);
    enrollment = await myEnrollment(student.token, course.id);
    expect(enrollment.progress).toMatchObject({
      totalItems: 2,
      completedItems: 2,
      percentage: 100,
      completionState: 'completed',
    });
    const completion = await get(
      student.token,
      `/learning/courses/${course.id}/completion`,
    ).expect(200);
    expect(completion.body.completed).toBe(true);

    // The public details read says what the course contains.
    const details = await request(app.getHttpServer())
      .get(`/public/websites/${academy.id}/courses/${course.id}`)
      .expect(200);
    expect(details.body.stats).toMatchObject({
      totalLessons: 0,
      totalQuizzes: 2,
      totalAssignments: 0,
    });
    // …and so does a "related courses" card for it on another course's page.
    const sibling = await seedCourse(
      admin,
      academy.id,
      `items-quiz-sibling-${Date.now()}`,
      {
        status: 'published',
        visibility: 'public',
        pricingType: 'free',
      },
    );
    const related = await request(app.getHttpServer())
      .get(`/public/websites/${academy.id}/courses/${sibling.id}/recommendations`)
      .expect(200);
    const relatedCard = (related.body as { id: string; stats: object }[]).find(
      (row) => row.id === course.id,
    );
    expect(relatedCard?.stats).toMatchObject({ totalLessons: 0, totalQuizzes: 2 });
    // …and so does the signed-in course details read (a learner's user
    // context cannot see quiz rows; the count comes from the Academy's).
    const discovered = await get(student.token, `/courses/${course.id}`).expect(200);
    expect(discovered.body.stats).toMatchObject({
      totalLessons: 0,
      totalQuizzes: 2,
      totalAssignments: 0,
    });
  });

  it('a mixed course counts its quiz, but an optional quiz does not decide completion', async () => {
    const { course, quizzes, student } = await seedCourseWith('items-mixed', 2, 1);
    let enrollment = await myEnrollment(student.token, course.id);
    expect(enrollment.progress).toMatchObject({
      totalLessons: 2,
      totalItems: 3,
      completedItems: 0,
    });

    await pass(student.token, course.id, quizzes[0]);
    enrollment = await myEnrollment(student.token, course.id);
    expect(enrollment.progress).toMatchObject({ totalItems: 3, completedItems: 1 });
    expect(enrollment.progress!.completionState).not.toBe('completed');
  });

  it('a lesson published after enrollment updates the item counts, not just the lesson counts', async () => {
    const { course, quizzes, student } = await seedCourseWith('items-added', 1, 1);
    const firstLesson = await admin.courseLesson.findFirstOrThrow({
      where: { courseId: course.id },
    });
    await post(student.token, `/courses/${course.id}/progress/complete-lesson`, {
      lessonId: firstLesson.id,
    }).expect(201);
    await pass(student.token, course.id, quizzes[0]);
    let enrollment = await myEnrollment(student.token, course.id);
    expect(enrollment.progress).toMatchObject({ totalItems: 2, completedItems: 2 });

    // The author publishes a second lesson; the learner's next progress
    // write (re-completing a done lesson is a no-op) materialises it.
    await seedCourseLesson(admin, firstLesson.sectionId, course.id, 'Lesson 2', 1, {
      status: 'published',
    });
    await post(student.token, `/courses/${course.id}/progress/complete-lesson`, {
      lessonId: firstLesson.id,
    }).expect(201);
    enrollment = await myEnrollment(student.token, course.id);
    expect(enrollment.progress).toMatchObject({
      totalLessons: 2,
      completedLessons: 1,
      totalItems: 3,
      completedItems: 2,
      percentage: expect.closeTo(66.67, 1),
    });
    expect(enrollment.progress!.completionState).not.toBe('completed');
  });

  it('a lesson-only course is unchanged: items are its lessons', async () => {
    const { academy, course, student } = await seedCourseWith('items-lessons', 3, 0);
    const enrollment = await myEnrollment(student.token, course.id);
    expect(enrollment.progress).toMatchObject({
      totalLessons: 3,
      totalItems: 3,
      completedItems: 0,
    });
    const details = await request(app.getHttpServer())
      .get(`/public/websites/${academy.id}/courses/${course.id}`)
      .expect(200);
    expect(details.body.stats).toMatchObject({ totalLessons: 3, totalQuizzes: 0 });
  });
});
