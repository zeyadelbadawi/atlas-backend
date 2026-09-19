/**
 * P64 Phase 1 — the critical fixes (master plan Phase 1 section D.1 and
 * audit findings S4, S6, S9, S10).
 *
 *   - concurrent quiz-attempt starts create exactly ONE attempt;
 *   - starting again while an attempt is open resumes it;
 *   - submitting is idempotent and validates option ownership;
 *   - a progress read on an enrollment with no progress rows never 500s;
 *   - the public course endpoints resolve by slug as well as by id.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
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

const PASSWORD = 'correct-horse-battery';

describe('P64 Phase 1 — critical fixes (e2e)', () => {
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

  async function world(label: string, opts: { maxAttempts?: number } = {}) {
    await flushRateLimitKeys();
    const ownerEmail = uniqueTestEmail(`${label}-owner`);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Owner', email: ownerEmail, password: PASSWORD })
      .expect(201);
    const ownerSignIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: ownerEmail, password: PASSWORD })
      .expect(200);
    const ownerId = ownerSignIn.body.user.id as string;

    const org = await seedOrganizationWithOwner(admin, ownerId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, ownerId, 'owner');
    const course = await seedCourse(admin, academy.id, `${label} Course`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    const section = await seedCourseSection(admin, course.id, `${label}-s`, 0);
    const lesson = await seedCourseLesson(admin, section.id, course.id, `${label}-l`, 0, {
      status: 'published',
    });
    const quiz = await seedQuiz(admin, course.id, `${label}-quiz`, {
      status: 'published',
      maxAttempts: opts.maxAttempts,
    });
    const question = await seedQuizQuestion(admin, quiz.id, 'Q1', 'single_choice', 0);
    const correct = await seedQuizQuestionOption(admin, question.id, 'Right', true);
    const wrong = await seedQuizQuestionOption(admin, question.id, 'Wrong', false);

    await flushRateLimitKeys();
    const studentEmail = uniqueTestEmail(`${label}-student`);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        name: 'Student',
        email: studentEmail,
        password: PASSWORD,
        academyId: academy.id,
      })
      .expect(201);
    const studentSignIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({
        email: studentEmail,
        password: PASSWORD,
        surface: 'academy',
        academyId: academy.id,
      })
      .expect(200);
    const student = {
      userId: studentSignIn.body.user.id as string,
      auth: { Authorization: `Bearer ${studentSignIn.body.accessToken as string}` },
    };
    await request(app.getHttpServer())
      .post('/enrollments')
      .set(student.auth)
      .send({ courseId: course.id })
      .expect(201);

    return {
      org,
      academy,
      course,
      section,
      lesson,
      quiz,
      question,
      correct,
      wrong,
      student,
    };
  }

  it('ten concurrent attempt starts create exactly one attempt', async () => {
    const w = await world('race', { maxAttempts: 3 });

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app.getHttpServer())
          .post(`/courses/${w.course.id}/quizzes/${w.quiz.id}/attempts`)
          .set(w.student.auth),
      ),
    );
    // Every call either created or resumed THE one attempt; none errored.
    for (const res of results) {
      expect([200, 201]).toContain(res.status);
    }

    const rows = await admin.quizAttempt.findMany({
      where: { quizId: w.quiz.id, studentId: w.student.userId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].attemptNumber).toBe(1);

    const ids = new Set(results.map((res) => res.body.id as string));
    expect(ids.size).toBe(1);
  });

  it('starting again while an attempt is open resumes it instead of burning an attempt', async () => {
    const w = await world('resume', { maxAttempts: 2 });
    const first = await request(app.getHttpServer())
      .post(`/courses/${w.course.id}/quizzes/${w.quiz.id}/attempts`)
      .set(w.student.auth)
      .expect(201);
    const second = await request(app.getHttpServer())
      .post(`/courses/${w.course.id}/quizzes/${w.quiz.id}/attempts`)
      .set(w.student.auth);
    expect([200, 201]).toContain(second.status);
    expect(second.body.id).toBe(first.body.id);

    const count = await admin.quizAttempt.count({
      where: { quizId: w.quiz.id, studentId: w.student.userId },
    });
    expect(count).toBe(1);
  });

  it('the attempt cap still holds across sequential attempts', async () => {
    const w = await world('cap', { maxAttempts: 2 });
    const answers = {
      answers: [{ questionId: w.question.id, selectedOptionIds: [w.correct.id] }],
    };

    for (let i = 0; i < 2; i += 1) {
      const started = await request(app.getHttpServer())
        .post(`/courses/${w.course.id}/quizzes/${w.quiz.id}/attempts`)
        .set(w.student.auth)
        .expect(201);
      await request(app.getHttpServer())
        .post(
          `/courses/${w.course.id}/quizzes/${w.quiz.id}/attempts/${started.body.id}/submit`,
        )
        .set(w.student.auth)
        .send(answers)
        .expect(201);
    }

    await request(app.getHttpServer())
      .post(`/courses/${w.course.id}/quizzes/${w.quiz.id}/attempts`)
      .set(w.student.auth)
      .expect(403);
  });

  it('rejects an option id that belongs to another question', async () => {
    const w = await world('foreign-option');
    const other = await seedQuizQuestion(admin, w.quiz.id, 'Q2', 'single_choice', 1);
    const foreign = await seedQuizQuestionOption(admin, other.id, 'Elsewhere', true);
    await seedQuizQuestionOption(admin, other.id, 'Also elsewhere', false);

    const started = await request(app.getHttpServer())
      .post(`/courses/${w.course.id}/quizzes/${w.quiz.id}/attempts`)
      .set(w.student.auth)
      .expect(201);

    const res = await request(app.getHttpServer())
      .post(
        `/courses/${w.course.id}/quizzes/${w.quiz.id}/attempts/${started.body.id}/submit`,
      )
      .set(w.student.auth)
      .send({
        answers: [
          { questionId: w.question.id, selectedOptionIds: [foreign.id] },
          { questionId: other.id, selectedOptionIds: [foreign.id] },
        ],
      })
      .expect(400);
    expect(res.body.error.messageKey).toBe('errors.quiz.invalidOption');

    const stored = await admin.quizAttempt.findUniqueOrThrow({
      where: { id: started.body.id },
    });
    expect(stored.status).toBe('in_progress');
  });

  it('a progress read materializes a missing rollup instead of failing', async () => {
    const w = await world('progress-upsert');
    const enrollment = await admin.enrollment.findFirstOrThrow({
      where: { studentId: w.student.userId, courseId: w.course.id },
    });
    // Reproduce the production shape this phase fixes: an enrollment with
    // no `course_progress` row at all.
    await admin.lessonProgress.deleteMany({ where: { enrollmentId: enrollment.id } });
    await admin.courseProgress.delete({ where: { enrollmentId: enrollment.id } });

    const progress = await request(app.getHttpServer())
      .get(`/courses/${w.course.id}/progress`)
      .set(w.student.auth)
      .expect(200);
    expect(progress.body.totalLessons).toBe(1);
    expect(progress.body.completedLessons).toBe(0);

    await request(app.getHttpServer())
      .post(`/courses/${w.course.id}/progress/complete-lesson`)
      .set(w.student.auth)
      .send({ lessonId: w.lesson.id })
      .expect(201);
  });

  it('the public course endpoints resolve by slug as well as by id', async () => {
    const w = await world('slug');
    const course = await admin.course.findUniqueOrThrow({ where: { id: w.course.id } });

    const byId = await request(app.getHttpServer())
      .get(`/public/websites/${w.academy.id}/courses/${course.id}`)
      .expect(200);
    const bySlug = await request(app.getHttpServer())
      .get(`/public/websites/${w.academy.id}/courses/${course.slug}`)
      .expect(200);
    expect(bySlug.body.id).toBe(byId.body.id);

    const curriculum = await request(app.getHttpServer())
      .get(`/public/websites/${w.academy.id}/courses/${course.slug}/curriculum`)
      .expect(200);
    expect(Array.isArray(curriculum.body)).toBe(true);

    // A slug that belongs to another academy is still not found here.
    const other = await world('slug-other');
    const otherCourse = await admin.course.findUniqueOrThrow({
      where: { id: other.course.id },
    });
    await request(app.getHttpServer())
      .get(`/public/websites/${w.academy.id}/courses/${otherCourse.slug}`)
      .expect(404);
  });
});
