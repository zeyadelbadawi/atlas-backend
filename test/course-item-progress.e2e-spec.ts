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
 *     lessons";
 *   - an authoring change that completes the course (a required quiz
 *     detached) reaches the learner's STORED verdict through the
 *     course-completion fan-out job, with no request of the learner's.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
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
import {
  COURSE_COMPLETION_RECOMPUTE_QUEUE,
  courseCompletionRecomputeJobId,
} from '../src/learning/queue/course-completion-recompute.types';

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
    // Every item sits in a unit: an item outside every unit is not part of
    // the course a learner can open, and doesn't count (B7 V15). Quizzes get
    // their own unit FIRST, so the sequential lock never holds them behind
    // the lessons (these tests pass quizzes in any order); an optional quiz
    // doesn't lock the lessons after it.
    const quizSection =
      quizzes > 0 ? await seedCourseSection(admin, course.id, 'Quizzes', 0) : null;
    const section =
      lessons > 0 ? await seedCourseSection(admin, course.id, 'Section', 1) : null;
    if (lessons > 0 && section) {
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
        sectionId: quizSection?.id,
      });
      const question = await seedQuizQuestion(admin, quiz.id, '2+2?', 'single_choice', 0);
      const correct = await seedQuizQuestionOption(admin, question.id, '4', true);
      await seedQuizQuestionOption(admin, question.id, '5', false);
      quizList.push({ id: quiz.id, questionId: question.id, correctId: correct.id });
    }
    const student = await signUpAndSignIn(`${label}-student`);
    await seedAcademyStudent(admin, academy.id, student.userId);
    await post(student.token, '/enrollments', { courseId: course.id }).expect(201);
    return { academy, host, course, quizzes: quizList, student, owner };
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

  it('B7 V15 — a published quiz outside every unit is not counted and does not block completion', async () => {
    const { course, student } = await seedCourseWith('items-detached', 1, 0);
    // Published, required, but in no unit: the curriculum and the player
    // never show it, so the learner could never open it.
    const detached = await seedQuiz(admin, course.id, 'Detached quiz', {
      status: 'published',
    });
    await admin.quiz.update({
      where: { id: detached.id },
      data: { requiredForCompletion: true },
    });
    const firstLesson = await admin.courseLesson.findFirstOrThrow({
      where: { courseId: course.id },
    });
    await post(student.token, `/courses/${course.id}/progress/complete-lesson`, {
      lessonId: firstLesson.id,
    }).expect(201);
    const enrollment = await myEnrollment(student.token, course.id);
    expect(enrollment.progress).toMatchObject({ totalItems: 1, completedItems: 1 });
    expect(enrollment.progress!.completionState).toBe('completed');
  });

  it('B7 V15 — detaching an unfinished required quiz completes the course on the next completion read', async () => {
    const { course, quizzes, student } = await seedCourseWith('items-detach-later', 1, 1);
    await admin.quiz.update({
      where: { id: quizzes[0].id },
      data: { requiredForCompletion: true },
    });
    const firstLesson = await admin.courseLesson.findFirstOrThrow({
      where: { courseId: course.id },
    });
    await post(student.token, `/courses/${course.id}/progress/complete-lesson`, {
      lessonId: firstLesson.id,
    }).expect(201);
    const before = await get(
      student.token,
      `/learning/courses/${course.id}/completion`,
    ).expect(200);
    expect(before.body.completed).toBe(false);

    // The author detaches the quiz the learner never took.
    await admin.quiz.update({ where: { id: quizzes[0].id }, data: { sectionId: null } });

    const after = await get(
      student.token,
      `/learning/courses/${course.id}/completion`,
    ).expect(200);
    expect(after.body.completed).toBe(true);
    expect(after.body.completionState).toBe('completed');
  });

  it('detaching an unfinished required quiz through the authoring API completes the stored verdict in the background, with no learner request', async () => {
    const { academy, course, quizzes, student, owner } = await seedCourseWith(
      'items-fanout',
      1,
      1,
    );
    // The owner authors through the real management endpoint.
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    // Required for COMPLETION only (never `requiredToProgress`): the quiz
    // sits in the first unit and locks nothing.
    await admin.quiz.update({
      where: { id: quizzes[0].id },
      data: { requiredForCompletion: true },
    });
    const firstLesson = await admin.courseLesson.findFirstOrThrow({
      where: { courseId: course.id },
    });
    await post(student.token, `/courses/${course.id}/progress/complete-lesson`, {
      lessonId: firstLesson.id,
    }).expect(201);
    const enrollment = await admin.enrollment.findUniqueOrThrow({
      where: { studentId_courseId: { studentId: student.userId, courseId: course.id } },
    });
    const stored = () =>
      admin.courseProgress.findUniqueOrThrow({ where: { enrollmentId: enrollment.id } });
    expect((await stored()).completionState).toBe('in_progress');

    // The author detaches the quiz the learner never took.
    await request(app.getHttpServer())
      .patch(`/courses/${course.id}/quizzes/${quizzes[0].id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ sectionId: null })
      .expect(200);

    // One job for the course, queued after the edit committed. Release its
    // short coalescing delay now instead of waiting for it.
    const queue = app.get<Queue>(getQueueToken(COURSE_COMPLETION_RECOMPUTE_QUEUE));
    const job = await queue.getJob(courseCompletionRecomputeJobId(course.id));
    expect(job).toBeDefined();
    expect(job!.data).toEqual({ courseId: course.id, academyId: academy.id });
    // Already released (or running) is fine: the poll below is the proof.
    await job!.promote().catch(() => undefined);

    // From here on the learner sends nothing: only the worker can move it.
    const deadline = Date.now() + 15_000;
    let progress = await stored();
    while (progress.completionState !== 'completed' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      progress = await stored();
    }
    expect(progress.completionState).toBe('completed');
    expect(progress.completedAt).not.toBeNull();
    const after = await admin.enrollment.findUniqueOrThrow({
      where: { id: enrollment.id },
    });
    expect(after.status).toBe('completed');
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
