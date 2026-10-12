/**
 * B0-LRN-09 — what an enrolled learner gets in two edge states.
 *
 * (a) The course is unpublished (back to draft, or archived) after they
 *     enrolled: the course stays on My Learn, and their progress is kept and
 *     still readable.
 * (b) The academy's subscription has lapsed: the learner's own progress
 *     writes (mark a lesson complete, the playback heartbeat) still succeed,
 *     like their own submissions and attempts. Only the organization's own
 *     management mutations are refused (`errors.subscription.required`).
 *     A late renewal therefore never costs a learner progress.
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
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

const PASSWORD = 'correct-horse-battery';

describe('B0-LRN-09 learner access edge states (e2e)', () => {
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
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      email,
      userId: signIn.body.user.id as string,
      token: signIn.body.accessToken as string,
    };
  }

  /** An Academy-surface session (password, then the emailed code), as `course-item-progress` does. */
  async function academySession(academyId: string, host: string, email: string) {
    const open = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .set('Host', host)
      .send({ email, password: PASSWORD, surface: 'academy', academyId })
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

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** A published free course with two lessons, a learner enrolled in it, and one lesson done. */
  async function enrolledLearner(label: string) {
    const owner = await signUpAndSignIn(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await admin.academy.update({ where: { id: academy.id }, data: { status: 'active' } });
    const host = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.lrn09.test`;
    await admin.domainConnection.create({
      data: { academyId: academy.id, hostname: host, status: 'connected' },
    });
    const course = await seedCourse(admin, academy.id, `${label}-course-${Date.now()}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    const section = await seedCourseSection(admin, course.id, 'Section', 0);
    const lesson1 = await seedCourseLesson(admin, section.id, course.id, 'Lesson 1', 0, {
      status: 'published',
    });
    const lesson2 = await seedCourseLesson(admin, section.id, course.id, 'Lesson 2', 1, {
      status: 'published',
    });

    const student = await signUpAndSignIn(`${label}-student`);
    await seedAcademyStudent(admin, academy.id, student.userId);
    await request(app.getHttpServer())
      .post('/enrollments')
      .set(as(student.token))
      .send({ courseId: course.id })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/courses/${course.id}/progress/complete-lesson`)
      .set(as(student.token))
      .send({ lessonId: lesson1.id })
      .expect(201);

    return { owner, org, academy, host, course, lesson1, lesson2, student };
  }

  describe('(a) the course is unpublished after enrolment', () => {
    it.each(['draft', 'archived'] as const)(
      'back to %s: progress is kept and readable, and the course stays on My Learn',
      async (status) => {
        const f = await enrolledLearner(`lrn09-unpub-${status}`);
        await admin.course.update({ where: { id: f.course.id }, data: { status } });

        const progress = await request(app.getHttpServer())
          .get(`/courses/${f.course.id}/progress`)
          .set(as(f.student.token));
        expect(progress.status).toBe(200);
        expect(progress.body.completedLessons).toBe(1);

        const academyToken = await academySession(f.academy.id, f.host, f.student.email);
        const overview = await request(app.getHttpServer())
          .get('/learning/overview')
          .set('Host', f.host)
          .set(as(academyToken));
        expect(overview.status).toBe(200);
        const card = (overview.body.continueLearning as { courseId: string }[]).find(
          (row) => row.courseId === f.course.id,
        );
        expect(card).toMatchObject({ completedLessons: 1 });

        // The enrolment row itself is untouched.
        const enrollment = await admin.enrollment.findFirstOrThrow({
          where: { courseId: f.course.id, studentId: f.student.userId },
        });
        expect(enrollment.status).toBe('enrolled');
      },
    );
  });

  describe('(b) the academy subscription has lapsed', () => {
    it("the learner's own progress writes still succeed; the owner's management writes are refused", async () => {
      const f = await enrolledLearner('lrn09-lapsed');
      await admin.tenantSubscription.update({
        where: { organizationId: f.org.id },
        data: { status: 'expired' },
      });

      const heartbeat = await request(app.getHttpServer())
        .post(`/learning/courses/${f.course.id}/playback`)
        .set(as(f.student.token))
        .send({ lessonId: f.lesson2.id, positionSeconds: 30 });
      expect(heartbeat.status).toBe(200);

      const complete = await request(app.getHttpServer())
        .post(`/courses/${f.course.id}/progress/complete-lesson`)
        .set(as(f.student.token))
        .send({ lessonId: f.lesson2.id });
      expect(complete.status).toBe(201);

      const progress = await request(app.getHttpServer())
        .get(`/courses/${f.course.id}/progress`)
        .set(as(f.student.token))
        .expect(200);
      expect(progress.body.completedLessons).toBe(2);

      // Control: the same lapse does stop the organization's own mutations.
      const refused = await request(app.getHttpServer())
        .patch(`/academies/${f.academy.id}/registration-policy`)
        .set(as(f.owner.token))
        .send({ registrationPolicy: 'approval' });
      expect(refused.status).toBe(403);
      expect(refused.body.error.messageKey).toBe('errors.subscription.required');
    });
  });
});
