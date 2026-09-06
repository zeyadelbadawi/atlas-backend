/**
 * LMS Completion — Quiz & Assignment Authoring (Phase 4, master plan
 * §22/§24) e2e suite. Exercises the real HTTP surface: the new
 * create/update/delete authoring endpoints on `QuizzesController`/
 * `AssignmentsController`, their course-scoped authorization
 * (`assertCanAuthorCourseContent`), the mandatory pre-submission
 * correctness-projection guarantee (unmodified, re-verified here), the
 * new real-file assignment-attachment upload path, and a full
 * author -> publish -> enroll -> take/submit -> grade round trip for
 * both a quiz and an assignment.
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
  seedEnrollment,
  seedMembership,
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

/** A tiny, real, valid base64 PNG (1x1 transparent pixel) — a real magic-byte-verifiable file, matching `file-validation.util.ts`'s own PNG signature exactly, not a fake/mocked upload. */
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const SINGLE_CHOICE_QUESTION = {
  prompt: 'What is 2 + 2?',
  type: 'single_choice' as const,
  options: [
    { label: '3', isCorrect: false },
    { label: '4', isCorrect: true },
    { label: '5', isCorrect: false },
  ],
};

describe('LMS Authoring (e2e) — Phase 4', () => {
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
    await request(app.getHttpServer()).post('/courses/x/quizzes').send({}).expect(401);
    await request(app.getHttpServer())
      .post('/courses/x/assignments')
      .send({})
      .expect(401);
  });

  it(
    'Owner: full quiz CRUD, and correct answers never leak pre-submission',
    async () => {
      const owner = await signUpAndSignIn(app, 'p24-a-owner');
      const org = await seedOrganizationWithOwner(admin, owner.userId, 'p24-a-org');
      const academy = await seedAcademy(admin, org.id, 'p24-a-academy');
      await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
      const course = await seedCourse(admin, academy.id, 'P24-A-Course', {
        status: 'published',
        visibility: 'public',
      });

      const created = await request(app.getHttpServer())
        .post(`/courses/${course.id}/quizzes`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          title: 'Arithmetic Quiz',
          status: 'published',
          passingScore: 100,
          questions: [SINGLE_CHOICE_QUESTION],
        })
        .expect(201);
      expect(created.body.questionCount).toBe(1);
      expect(created.body.questions[0].options[1].isCorrect).toBe(true);
      const quizId = created.body.id as string;

      // The pre-existing, unmodified student-safe read never carries
      // isCorrect — checked here as a real enrolled student (the only
      // caller `assertCourseReadAccess`/`getQuiz` actually admits; an
      // Owner with no enrollment or course_instructors row correctly
      // gets 404 from this same route, proven separately below).
      const reader = await signUpAndSignIn(app, 'p24-a-reader');
      await seedAcademyStudent(admin, academy.id, reader.userId);
      await seedEnrollment(admin, reader.userId, course.id, academy.id);
      const studentSafe = await request(app.getHttpServer())
        .get(`/courses/${course.id}/quizzes/${quizId}`)
        .set('Authorization', `Bearer ${reader.accessToken}`)
        .expect(200);
      expect(
        studentSafe.body.questions.every(
          (q: { options: unknown[] }) =>
            q.options.every((o) => !Object.prototype.hasOwnProperty.call(o, 'isCorrect')),
        ),
      ).toBe(true);

      // The authoring read DOES carry isCorrect, for the real author.
      const authoringRead = await request(app.getHttpServer())
        .get(`/courses/${course.id}/quizzes/${quizId}/authoring`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(authoringRead.body.questions[0].options[1].isCorrect).toBe(true);

      const updated = await request(app.getHttpServer())
        .patch(`/courses/${course.id}/quizzes/${quizId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ title: 'Arithmetic Quiz (Revised)' })
        .expect(200);
      expect(updated.body.title).toBe('Arithmetic Quiz (Revised)');
      expect(updated.body.questionCount).toBe(1); // untouched — questions omitted.

      const replaced = await request(app.getHttpServer())
        .patch(`/courses/${course.id}/quizzes/${quizId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          questions: [
            SINGLE_CHOICE_QUESTION,
            {
              prompt: 'The sky is blue.',
              type: 'true_false',
              options: [
                { label: 'True', isCorrect: true },
                { label: 'False', isCorrect: false },
              ],
            },
          ],
        })
        .expect(200);
      expect(replaced.body.questionCount).toBe(2);

      await request(app.getHttpServer())
        .delete(`/courses/${course.id}/quizzes/${quizId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(204);

      await request(app.getHttpServer())
        .get(`/courses/${course.id}/quizzes/${quizId}/authoring`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(404);

      const row = await admin.quiz.findUnique({ where: { id: quizId } });
      expect(row).toBeNull();
    },
    20000,
  );

  it(
    'rejects malformed question shapes (wrong correct-option counts)',
    async () => {
      const owner = await signUpAndSignIn(app, 'p24-b-owner');
      const org = await seedOrganizationWithOwner(admin, owner.userId, 'p24-b-org');
      const academy = await seedAcademy(admin, org.id, 'p24-b-academy');
      await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
      const course = await seedCourse(admin, academy.id, 'P24-B-Course');

      // single_choice with two correct options.
      await request(app.getHttpServer())
        .post(`/courses/${course.id}/quizzes`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          title: 'Bad Quiz A',
          questions: [
            {
              prompt: 'Pick one',
              type: 'single_choice',
              options: [
                { label: 'A', isCorrect: true },
                { label: 'B', isCorrect: true },
              ],
            },
          ],
        })
        .expect(400);

      // true_false with three options.
      await request(app.getHttpServer())
        .post(`/courses/${course.id}/quizzes`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          title: 'Bad Quiz B',
          questions: [
            {
              prompt: 'True or false?',
              type: 'true_false',
              options: [
                { label: 'True', isCorrect: true },
                { label: 'False', isCorrect: false },
                { label: 'Maybe', isCorrect: false },
              ],
            },
          ],
        })
        .expect(400);

      // multiple_choice with zero correct options.
      await request(app.getHttpServer())
        .post(`/courses/${course.id}/quizzes`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          title: 'Bad Quiz C',
          questions: [
            {
              prompt: 'Pick any',
              type: 'multiple_choice',
              options: [
                { label: 'A', isCorrect: false },
                { label: 'B', isCorrect: false },
              ],
            },
          ],
        })
        .expect(400);
    },
    20000,
  );

  it(
    'Instructor: can author quizzes/assignments only for a course they are assigned to',
    async () => {
      const owner = await signUpAndSignIn(app, 'p24-c-owner');
      const org = await seedOrganizationWithOwner(admin, owner.userId, 'p24-c-org');
      const academy = await seedAcademy(admin, org.id, 'p24-c-academy');
      await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
      const assignedCourse = await seedCourse(admin, academy.id, 'P24-C-Assigned');
      const otherCourse = await seedCourse(admin, academy.id, 'P24-C-Other');

      const instructor = await signUpAndSignIn(app, 'p24-c-instructor');
      await seedMembership(admin, org.id, instructor.userId, 'instructor');
      await seedAcademyMember(admin, academy.id, instructor.userId, 'instructor');
      await admin.courseInstructor.create({
        data: { courseId: assignedCourse.id, userId: instructor.userId },
      });

      // Assigned course: quiz + assignment authoring both succeed.
      const quiz = await request(app.getHttpServer())
        .post(`/courses/${assignedCourse.id}/quizzes`)
        .set('Authorization', `Bearer ${instructor.accessToken}`)
        .send({ title: 'Instructor Quiz', questions: [SINGLE_CHOICE_QUESTION] })
        .expect(201);
      expect(quiz.body.title).toBe('Instructor Quiz');

      const assignment = await request(app.getHttpServer())
        .post(`/courses/${assignedCourse.id}/assignments`)
        .set('Authorization', `Bearer ${instructor.accessToken}`)
        .send({ title: 'Instructor Assignment' })
        .expect(201);
      expect(assignment.body.title).toBe('Instructor Assignment');

      // A course this instructor is NOT assigned to: both rejected, 404.
      await request(app.getHttpServer())
        .post(`/courses/${otherCourse.id}/quizzes`)
        .set('Authorization', `Bearer ${instructor.accessToken}`)
        .send({ title: 'Should Fail', questions: [SINGLE_CHOICE_QUESTION] })
        .expect(404);
      await request(app.getHttpServer())
        .post(`/courses/${otherCourse.id}/assignments`)
        .set('Authorization', `Bearer ${instructor.accessToken}`)
        .send({ title: 'Should Fail' })
        .expect(404);
    },
    20000,
  );

  it(
    'a total stranger cannot author quiz/assignment content for a course they have no relationship to',
    async () => {
      const owner = await signUpAndSignIn(app, 'p24-d-owner');
      const org = await seedOrganizationWithOwner(admin, owner.userId, 'p24-d-org');
      const academy = await seedAcademy(admin, org.id, 'p24-d-academy');
      await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
      const course = await seedCourse(admin, academy.id, 'P24-D-Course');

      const stranger = await signUpAndSignIn(app, 'p24-d-stranger');
      await request(app.getHttpServer())
        .post(`/courses/${course.id}/quizzes`)
        .set('Authorization', `Bearer ${stranger.accessToken}`)
        .send({ title: 'Should Fail', questions: [SINGLE_CHOICE_QUESTION] })
        .expect(404);
      await request(app.getHttpServer())
        .post(`/courses/${course.id}/assignments`)
        .set('Authorization', `Bearer ${stranger.accessToken}`)
        .send({ title: 'Should Fail' })
        .expect(404);
    },
    20000,
  );

  it(
    'an Academy instructor (roster member, not course-assigned) cannot author quiz/assignment content',
    async () => {
      const owner = await signUpAndSignIn(app, 'p24-e-owner');
      const org = await seedOrganizationWithOwner(admin, owner.userId, 'p24-e-org');
      const academy = await seedAcademy(admin, org.id, 'p24-e-academy');
      await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
      const course = await seedCourse(admin, academy.id, 'P24-E-Course');

      const rosterInstructor = await signUpAndSignIn(app, 'p24-e-instructor');
      await seedMembership(admin, org.id, rosterInstructor.userId, 'instructor');
      await seedAcademyMember(admin, academy.id, rosterInstructor.userId, 'instructor');
      // Deliberately never assigned to `course` via `course_instructors`.

      await request(app.getHttpServer())
        .post(`/courses/${course.id}/quizzes`)
        .set('Authorization', `Bearer ${rosterInstructor.accessToken}`)
        .send({ title: 'Should Fail', questions: [SINGLE_CHOICE_QUESTION] })
        .expect(404);
    },
    20000,
  );

  it(
    'Full round trip: author -> publish -> enroll -> take quiz -> auto-scored result',
    async () => {
      const owner = await signUpAndSignIn(app, 'p24-f-owner');
      const org = await seedOrganizationWithOwner(admin, owner.userId, 'p24-f-org');
      const academy = await seedAcademy(admin, org.id, 'p24-f-academy');
      await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
      const course = await seedCourse(admin, academy.id, 'P24-F-Course', {
        status: 'published',
        visibility: 'public',
      });

      const created = await request(app.getHttpServer())
        .post(`/courses/${course.id}/quizzes`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          title: 'Round Trip Quiz',
          status: 'published',
          passingScore: 100,
          questions: [SINGLE_CHOICE_QUESTION],
        })
        .expect(201);
      const quizId = created.body.id as string;
      const correctOptionId = created.body.questions[0].options.find(
        (o: { isCorrect: boolean }) => o.isCorrect,
      ).id as string;

      const student = await signUpAndSignIn(app, 'p24-f-student');
      await seedAcademyStudent(admin, academy.id, student.userId);
      await seedEnrollment(admin, student.userId, course.id, academy.id);

      const studentQuiz = await request(app.getHttpServer())
        .get(`/courses/${course.id}/quizzes/${quizId}`)
        .set('Authorization', `Bearer ${student.accessToken}`)
        .expect(200);
      const questionId = studentQuiz.body.questions[0].id as string;

      const attempt = await request(app.getHttpServer())
        .post(`/courses/${course.id}/quizzes/${quizId}/attempts`)
        .set('Authorization', `Bearer ${student.accessToken}`)
        .expect(201);

      const submitted = await request(app.getHttpServer())
        .post(`/courses/${course.id}/quizzes/${quizId}/attempts/${attempt.body.id}/submit`)
        .set('Authorization', `Bearer ${student.accessToken}`)
        .send({ answers: [{ questionId, selectedOptionIds: [correctOptionId] }] })
        .expect(201);

      expect(submitted.body.score).toBe(100);
      expect(submitted.body.passed).toBe(true);
    },
    20000,
  );

  it(
    'Full round trip: author assignment -> publish -> student uploads a real file and submits -> instructor grades',
    async () => {
      const owner = await signUpAndSignIn(app, 'p24-g-owner');
      const org = await seedOrganizationWithOwner(admin, owner.userId, 'p24-g-org');
      await seedActiveSubscriptionForOrg(admin, org.id, 'p24-g');
      const academy = await seedAcademy(admin, org.id, 'p24-g-academy');
      await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
      const course = await seedCourse(admin, academy.id, 'P24-G-Course', {
        status: 'published',
        visibility: 'public',
      });

      const instructor = await signUpAndSignIn(app, 'p24-g-instructor');
      await seedMembership(admin, org.id, instructor.userId, 'instructor');
      await seedAcademyMember(admin, academy.id, instructor.userId, 'instructor');
      await admin.courseInstructor.create({
        data: { courseId: course.id, userId: instructor.userId },
      });

      const created = await request(app.getHttpServer())
        .post(`/courses/${course.id}/assignments`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ title: 'Round Trip Assignment', status: 'published' })
        .expect(201);
      const assignmentId = created.body.id as string;

      const student = await signUpAndSignIn(app, 'p24-g-student');
      await seedAcademyStudent(admin, academy.id, student.userId);
      await seedEnrollment(admin, student.userId, course.id, academy.id);

      const uploaded = await request(app.getHttpServer())
        .post(`/courses/${course.id}/assignments/${assignmentId}/submission/attachment`)
        .set('Authorization', `Bearer ${student.accessToken}`)
        .send({
          fileName: 'homework.png',
          mimeType: 'image/png',
          sizeBytes: 100,
          dataUrl: TINY_PNG_DATA_URL,
        })
        .expect(201);
      expect(uploaded.body.url).toEqual(expect.stringContaining('http'));
      expect(uploaded.body.type).toBe('image');

      // Real R2/`media_assets` row — never base64-in-database.
      const mediaRow = await admin.mediaAsset.findUnique({ where: { id: uploaded.body.id } });
      expect(mediaRow).not.toBeNull();
      expect(mediaRow!.academyId).toBe(academy.id);

      const submission = await request(app.getHttpServer())
        .post(`/courses/${course.id}/assignments/${assignmentId}/submission`)
        .set('Authorization', `Bearer ${student.accessToken}`)
        .send({ response: 'Here is my work.', attachmentUrl: uploaded.body.url })
        .expect(201);
      expect(submission.body.attachmentUrl).toBe(uploaded.body.url);
      expect(submission.body.attachmentUrl).not.toEqual(expect.stringContaining('base64'));

      const graded = await request(app.getHttpServer())
        .post(
          `/instructor/courses/${course.id}/assignments/${assignmentId}/submissions/${submission.body.id}/grade`,
        )
        .set('Authorization', `Bearer ${instructor.accessToken}`)
        .send({ score: 92, feedback: 'Good work.' })
        .expect(201);
      expect(graded.body.grade.score).toBe(92);
      expect(graded.body.gradingStatus).toBe('graded');
    },
    20000,
  );

  it(
    'rejects a submission-attachment upload from a student who is not actively enrolled',
    async () => {
      const owner = await signUpAndSignIn(app, 'p24-h-owner');
      const org = await seedOrganizationWithOwner(admin, owner.userId, 'p24-h-org');
      const academy = await seedAcademy(admin, org.id, 'p24-h-academy');
      await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
      const course = await seedCourse(admin, academy.id, 'P24-H-Course', {
        status: 'published',
        visibility: 'public',
      });
      const assignment = await request(app.getHttpServer())
        .post(`/courses/${course.id}/assignments`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ title: 'Gated Assignment', status: 'published' })
        .expect(201);

      const outsider = await signUpAndSignIn(app, 'p24-h-outsider');
      await request(app.getHttpServer())
        .post(`/courses/${course.id}/assignments/${assignment.body.id}/submission/attachment`)
        .set('Authorization', `Bearer ${outsider.accessToken}`)
        .send({
          fileName: 'homework.png',
          mimeType: 'image/png',
          sizeBytes: 100,
          dataUrl: TINY_PNG_DATA_URL,
        })
        .expect(404);
    },
    20000,
  );

  it(
    'assignment authoring list/detail return every status (draft included), unlike the student-safe published-only read',
    async () => {
      const owner = await signUpAndSignIn(app, 'p24-i-owner');
      const org = await seedOrganizationWithOwner(admin, owner.userId, 'p24-i-org');
      const academy = await seedAcademy(admin, org.id, 'p24-i-academy');
      await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
      const course = await seedCourse(admin, academy.id, 'P24-I-Course');

      const draft = await request(app.getHttpServer())
        .post(`/courses/${course.id}/assignments`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ title: 'Still Draft' })
        .expect(201);
      expect(draft.body.status).toBe('draft');

      const authoringList = await request(app.getHttpServer())
        .get(`/courses/${course.id}/assignments/authoring`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(authoringList.body.items.map((a: { id: string }) => a.id)).toContain(
        draft.body.id,
      );

      // The student-safe route (`assertCourseReadAccess`, unmodified)
      // only admits a real enrolled student or course instructor — an
      // Owner with neither correctly gets 404 from it, so this check
      // uses a real enrolled student, matching the equivalent quiz test
      // above.
      const reader = await signUpAndSignIn(app, 'p24-i-reader');
      await seedAcademyStudent(admin, academy.id, reader.userId);
      await seedEnrollment(admin, reader.userId, course.id, academy.id);
      const studentSafeList = await request(app.getHttpServer())
        .get(`/courses/${course.id}/assignments`)
        .set('Authorization', `Bearer ${reader.accessToken}`)
        .expect(200);
      expect(studentSafeList.body.items.map((a: { id: string }) => a.id)).not.toContain(
        draft.body.id,
      );
    },
    20000,
  );
});
