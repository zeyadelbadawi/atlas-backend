/**
 * Quizzes — `QuizService` (P6, master plan §21). No write endpoint for
 * quizzes/questions/options (seeded via the admin connection, matching
 * `course_categories`/`course_instructors`'s precedent from P5). The
 * mandatory quiz-correctness projection test (master plan §18 scenario 7)
 * lives here.
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

describe('Quizzes (e2e)', () => {
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

  async function seedEnrolledStudentWithQuiz(
    label: string,
    quizOverrides: { passingScore?: number; maxAttempts?: number } = {},
  ) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    const course = await seedCourse(admin, academy.id, `${label}-course-${Date.now()}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    const quiz = await seedQuiz(admin, course.id, `${label} quiz`, {
      status: 'published',
      ...quizOverrides,
    });
    const question = await seedQuizQuestion(
      admin,
      quiz.id,
      'What is 2+2?',
      'single_choice',
      0,
    );
    const correct = await seedQuizQuestionOption(admin, question.id, '4', true);
    const wrong = await seedQuizQuestionOption(admin, question.id, '5', false);

    const student = await signUpAndSignIn(app, `${label}-student`);
    await seedAcademyStudent(admin, academy.id, student.userId);
    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ courseId: course.id })
      .expect(201);

    return { course, quiz, question, correct, wrong, student };
  }

  it('requires authentication', async () => {
    await request(app.getHttpServer()).get('/courses/x/quizzes').expect(401);
  });

  it('404s quizzes for a course the student is not enrolled in', async () => {
    const owner = await signUpAndSignIn(app, 'quiz-noenroll-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'quiz-noenroll-org');
    const academy = await seedAcademy(admin, org.id, 'quiz-noenroll-academy');
    const course = await seedCourse(admin, academy.id, `noenroll-${Date.now()}`, {
      status: 'published',
      visibility: 'public',
    });
    const student = await signUpAndSignIn(app, 'quiz-noenroll-student');
    await request(app.getHttpServer())
      .get(`/courses/${course.id}/quizzes`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(404);
  });

  it('SECURITY: a quiz question response never contains isCorrect or any value it could be derived from', async () => {
    const { course, quiz, student } = await seedEnrolledStudentWithQuiz('quiz-security');

    const response = await request(app.getHttpServer())
      .get(`/courses/${course.id}/quizzes/${quiz.id}`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);

    const raw = JSON.stringify(response.body);
    expect(raw).not.toMatch(/isCorrect/i);
    for (const question of response.body.questions) {
      for (const option of question.options) {
        expect(Object.keys(option).sort()).toEqual(['id', 'label']);
      }
    }
  });

  it('lists published quizzes for the course with a real questionCount, no questions embedded', async () => {
    const { course, quiz, student } = await seedEnrolledStudentWithQuiz('quiz-list');
    const list = await request(app.getHttpServer())
      .get(`/courses/${course.id}/quizzes`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);

    const found = list.body.items.find((q: { id: string }) => q.id === quiz.id);
    expect(found).toMatchObject({ questionCount: 1, status: 'published' });
    expect(found.questions).toBeUndefined();
  });

  it('full attempt lifecycle: start -> submit correct answers -> passed, canRetry reflects maxAttempts', async () => {
    const { course, quiz, question, correct, student } =
      await seedEnrolledStudentWithQuiz('quiz-lifecycle', {
        passingScore: 50,
        maxAttempts: 2,
      });

    const started = await request(app.getHttpServer())
      .post(`/courses/${course.id}/quizzes/${quiz.id}/attempts`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(201);
    expect(started.body).toMatchObject({
      status: 'in_progress',
      attemptNumber: 1,
      canRetry: true,
    });

    const submitted = await request(app.getHttpServer())
      .post(`/courses/${course.id}/quizzes/${quiz.id}/attempts/${started.body.id}/submit`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ answers: [{ questionId: question.id, selectedOptionIds: [correct.id] }] })
      .expect(201);

    expect(submitted.body).toMatchObject({ status: 'passed', score: 100, passed: true });
    expect(submitted.body.canRetry).toBe(true); // 1 of 2 attempts used

    const attempts = await request(app.getHttpServer())
      .get(`/courses/${course.id}/quizzes/${quiz.id}/attempts`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);
    expect(attempts.body.items).toHaveLength(1);
  });

  it('wrong answers fail the attempt against a real passing score', async () => {
    const { course, quiz, question, wrong, student } = await seedEnrolledStudentWithQuiz(
      'quiz-fail',
      { passingScore: 100 },
    );

    const started = await request(app.getHttpServer())
      .post(`/courses/${course.id}/quizzes/${quiz.id}/attempts`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(201);

    const submitted = await request(app.getHttpServer())
      .post(`/courses/${course.id}/quizzes/${quiz.id}/attempts/${started.body.id}/submit`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ answers: [{ questionId: question.id, selectedOptionIds: [wrong.id] }] })
      .expect(201);

    expect(submitted.body).toMatchObject({ status: 'failed', score: 0, passed: false });
  });

  it("rejects a submission missing an answer for a question — mirrors the frontend's own required-every-question rule", async () => {
    const { course, quiz, student } =
      await seedEnrolledStudentWithQuiz('quiz-incomplete');
    const started = await request(app.getHttpServer())
      .post(`/courses/${course.id}/quizzes/${quiz.id}/attempts`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(201);

    await request(app.getHttpServer())
      .post(`/courses/${course.id}/quizzes/${quiz.id}/attempts/${started.body.id}/submit`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ answers: [] })
      .expect(400);
  });

  it('rejects submitting the same attempt twice', async () => {
    const { course, quiz, question, correct, student } =
      await seedEnrolledStudentWithQuiz('quiz-resubmit');
    const started = await request(app.getHttpServer())
      .post(`/courses/${course.id}/quizzes/${quiz.id}/attempts`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(201);
    const answers = {
      answers: [{ questionId: question.id, selectedOptionIds: [correct.id] }],
    };

    await request(app.getHttpServer())
      .post(`/courses/${course.id}/quizzes/${quiz.id}/attempts/${started.body.id}/submit`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send(answers)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/courses/${course.id}/quizzes/${quiz.id}/attempts/${started.body.id}/submit`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send(answers)
      .expect(400);
  });

  it('enforces maxAttempts — a new attempt is rejected once the limit is reached', async () => {
    const { course, quiz, question, wrong, student } = await seedEnrolledStudentWithQuiz(
      'quiz-maxattempts',
      { maxAttempts: 1 },
    );

    const first = await request(app.getHttpServer())
      .post(`/courses/${course.id}/quizzes/${quiz.id}/attempts`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/courses/${course.id}/quizzes/${quiz.id}/attempts/${first.body.id}/submit`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ answers: [{ questionId: question.id, selectedOptionIds: [wrong.id] }] })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/courses/${course.id}/quizzes/${quiz.id}/attempts`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(403);
  });
});
