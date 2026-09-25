/**
 * Authoring deletes never erase learner records (cloud remediation,
 * finding D).
 *
 * Section → lesson → `lesson_progress`, quiz → `quiz_attempts`/
 * `quiz_results`, assignment → `assignment_submissions` are all
 * `ON DELETE CASCADE`, and referential actions ignore RLS. Before the fix a
 * delete of any of these silently destroyed every learner's record for it.
 *
 * The rule pinned here, against real Postgres as `atlas_app`:
 *   - content with learner activity → 409 `errors.course.hasLearnerActivity`,
 *     and the content AND the learner record both survive;
 *   - content with no learner activity → deleted as before.
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
  seedAssignment,
  seedCourse,
  seedCourseLesson,
  seedCourseSection,
  seedEnrollment,
  seedOrganizationWithOwner,
  seedQuiz,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

async function signUpAndSignIn(app: INestApplication, label: string) {
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
    userId: signIn.body.user.id as string,
    accessToken: signIn.body.accessToken as string,
  };
}

describe('Authoring deletes vs learner records (e2e, real Postgres)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  async function arrange(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const course = await seedCourse(admin, academy.id, `${label}-course`, {
      status: 'published',
    });
    const section = await seedCourseSection(admin, course.id, `${label}-section`, 1);
    const lesson = await seedCourseLesson(
      admin,
      section.id,
      course.id,
      `${label}-lesson`,
      1,
    );
    const quiz = await seedQuiz(admin, course.id, `${label}-quiz`, {
      status: 'published',
    });
    const assignment = await seedAssignment(admin, course.id, `${label}-assignment`, {
      status: 'published',
    });
    const student = await signUpAndSignIn(app, `${label}-student`);
    await seedAcademyStudent(admin, academy.id, student.userId);
    const enrollment = await seedEnrollment(
      admin,
      student.userId,
      course.id,
      academy.id,
      {
        status: 'enrolled',
      },
    );
    return {
      owner,
      org,
      academy,
      course,
      section,
      lesson,
      quiz,
      assignment,
      student,
      enrollment,
    };
  }

  it('refuses to delete a lesson — and its section — once a learner has progress', async () => {
    const w = await arrange('del-lesson-activity');
    const progress = await admin.lessonProgress.create({
      data: {
        enrollmentId: w.enrollment.id,
        lessonId: w.lesson.id,
        sectionId: w.section.id,
        courseId: w.course.id,
      },
    });
    const base = `/academies/${w.academy.id}/courses/${w.course.id}/sections/${w.section.id}`;

    const lessonRes = await request(app.getHttpServer())
      .delete(`${base}/lessons/${w.lesson.id}`)
      .set('Authorization', `Bearer ${w.owner.accessToken}`)
      .expect(409);
    expect(lessonRes.body.error.messageKey).toBe('errors.course.hasLearnerActivity');

    const sectionRes = await request(app.getHttpServer())
      .delete(base)
      .set('Authorization', `Bearer ${w.owner.accessToken}`)
      .expect(409);
    expect(sectionRes.body.error.messageKey).toBe('errors.course.hasLearnerActivity');

    expect(
      await admin.courseLesson.findUnique({ where: { id: w.lesson.id } }),
    ).not.toBeNull();
    expect(
      await admin.lessonProgress.findUnique({ where: { id: progress.id } }),
    ).not.toBeNull();
  });

  it('refuses to delete a quiz once a learner has an attempt', async () => {
    const w = await arrange('del-quiz-activity');
    const attempt = await admin.quizAttempt.create({
      data: {
        quizId: w.quiz.id,
        studentId: w.student.userId,
        status: 'submitted',
        attemptNumber: 1,
      },
    });
    const res = await request(app.getHttpServer())
      .delete(`/courses/${w.course.id}/quizzes/${w.quiz.id}`)
      .set('Authorization', `Bearer ${w.owner.accessToken}`)
      .expect(409);
    expect(res.body.error.messageKey).toBe('errors.course.hasLearnerActivity');
    expect(await admin.quiz.findUnique({ where: { id: w.quiz.id } })).not.toBeNull();
    expect(
      await admin.quizAttempt.findUnique({ where: { id: attempt.id } }),
    ).not.toBeNull();
  });

  it('refuses to delete an assignment once a learner has a submission', async () => {
    const w = await arrange('del-assignment-activity');
    const submission = await admin.assignmentSubmission.create({
      data: {
        assignmentId: w.assignment.id,
        studentId: w.student.userId,
        status: 'submitted',
      },
    });
    const res = await request(app.getHttpServer())
      .delete(`/courses/${w.course.id}/assignments/${w.assignment.id}`)
      .set('Authorization', `Bearer ${w.owner.accessToken}`)
      .expect(409);
    expect(res.body.error.messageKey).toBe('errors.course.hasLearnerActivity');
    expect(
      await admin.assignment.findUnique({ where: { id: w.assignment.id } }),
    ).not.toBeNull();
    expect(
      await admin.assignmentSubmission.findUnique({ where: { id: submission.id } }),
    ).not.toBeNull();
  });

  it('still deletes content no learner has touched', async () => {
    const w = await arrange('del-untouched');
    const base = `/academies/${w.academy.id}/courses/${w.course.id}/sections/${w.section.id}`;
    await request(app.getHttpServer())
      .delete(`/courses/${w.course.id}/quizzes/${w.quiz.id}`)
      .set('Authorization', `Bearer ${w.owner.accessToken}`)
      .expect((res) => expect([200, 204]).toContain(res.status));
    await request(app.getHttpServer())
      .delete(`/courses/${w.course.id}/assignments/${w.assignment.id}`)
      .set('Authorization', `Bearer ${w.owner.accessToken}`)
      .expect((res) => expect([200, 204]).toContain(res.status));
    await request(app.getHttpServer())
      .delete(`${base}/lessons/${w.lesson.id}`)
      .set('Authorization', `Bearer ${w.owner.accessToken}`)
      .expect((res) => expect([200, 204]).toContain(res.status));
    await request(app.getHttpServer())
      .delete(base)
      .set('Authorization', `Bearer ${w.owner.accessToken}`)
      .expect((res) => expect([200, 204]).toContain(res.status));

    expect(await admin.quiz.findUnique({ where: { id: w.quiz.id } })).toBeNull();
    expect(
      await admin.assignment.findUnique({ where: { id: w.assignment.id } }),
    ).toBeNull();
    expect(
      await admin.courseSection.findUnique({ where: { id: w.section.id } }),
    ).toBeNull();
  });
});
