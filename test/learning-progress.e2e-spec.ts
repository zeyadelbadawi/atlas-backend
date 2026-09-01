/**
 * Course/Lesson Progress — `ProgressService` (P6, master plan §21).
 * Progress is materialized at enrollment time and updated transactionally
 * on lesson completion — never lazily derived, never a background job.
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

describe('Course/Lesson Progress (e2e)', () => {
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

  async function seedEnrollableCourseWithLessons(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    const course = await seedCourse(admin, academy.id, `${label}-course-${Date.now()}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    const section = await seedCourseSection(admin, course.id, 'Section 1', 0);
    const lesson1 = await seedCourseLesson(admin, section.id, course.id, 'Lesson 1', 0, {
      status: 'published',
    });
    const lesson2 = await seedCourseLesson(admin, section.id, course.id, 'Lesson 2', 1, {
      status: 'published',
    });
    // A draft lesson must never count toward totals or appear in progress.
    await seedCourseLesson(admin, section.id, course.id, 'Draft Lesson', 2, {
      status: 'draft',
    });
    return { course, section, lesson1, lesson2 };
  }

  it('requires authentication', async () => {
    await request(app.getHttpServer()).get('/courses/x/progress').expect(401);
  });

  it('404s progress for a course the student is not enrolled in', async () => {
    const { course } = await seedEnrollableCourseWithLessons('progress-noenroll');
    const student = await signUpAndSignIn(app, 'progress-noenroll-student');
    await request(app.getHttpServer())
      .get(`/courses/${course.id}/progress`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(404);
  });

  it('materializes progress at enrollment: only published lessons counted, first lesson available, the rest locked', async () => {
    const { course, lesson1, lesson2 } =
      await seedEnrollableCourseWithLessons('progress-init');
    const student = await signUpAndSignIn(app, 'progress-init-student');
    await seedAcademyStudent(admin, course.academyId, student.userId);
    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ courseId: course.id })
      .expect(201);

    const progress = await request(app.getHttpServer())
      .get(`/courses/${course.id}/progress`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);

    expect(progress.body.totalLessons).toBe(2); // draft lesson excluded
    expect(progress.body.completedLessons).toBe(0);
    expect(progress.body.completionState).toBe('incomplete');
    expect(progress.body.certificateStatus).toBe('unavailable');
    expect(progress.body.currentLessonId).toBe(lesson1.id);

    const byId = new Map(
      progress.body.lessons.map((l: { lessonId: string; status: string }) => [
        l.lessonId,
        l.status,
      ]),
    );
    expect(byId.get(lesson1.id)).toBe('available');
    expect(byId.get(lesson2.id)).toBe('locked');
  });

  it('rejects completing a locked lesson', async () => {
    const { course, lesson2 } = await seedEnrollableCourseWithLessons('progress-locked');
    const student = await signUpAndSignIn(app, 'progress-locked-student');
    await seedAcademyStudent(admin, course.academyId, student.userId);
    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ courseId: course.id })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/courses/${course.id}/progress/complete-lesson`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ lessonId: lesson2.id })
      .expect(403);
  });

  it('completing a lesson unlocks the next one and advances the current lesson pointer', async () => {
    const { course, lesson1, lesson2 } =
      await seedEnrollableCourseWithLessons('progress-advance');
    const student = await signUpAndSignIn(app, 'progress-advance-student');
    await seedAcademyStudent(admin, course.academyId, student.userId);
    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ courseId: course.id })
      .expect(201);

    const afterFirst = await request(app.getHttpServer())
      .post(`/courses/${course.id}/progress/complete-lesson`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ lessonId: lesson1.id })
      .expect(201);

    expect(afterFirst.body.completedLessons).toBe(1);
    expect(afterFirst.body.percentage).toBe(50);
    expect(afterFirst.body.completionState).toBe('in_progress');
    expect(afterFirst.body.currentLessonId).toBe(lesson2.id);
    const byId = new Map(
      afterFirst.body.lessons.map((l: { lessonId: string; status: string }) => [
        l.lessonId,
        l.status,
      ]),
    );
    expect(byId.get(lesson2.id)).toBe('available');
  });

  it('is idempotent — completing an already-completed lesson is a no-op, not an error', async () => {
    const { course, lesson1 } =
      await seedEnrollableCourseWithLessons('progress-idempotent');
    const student = await signUpAndSignIn(app, 'progress-idempotent-student');
    await seedAcademyStudent(admin, course.academyId, student.userId);
    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ courseId: course.id })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/courses/${course.id}/progress/complete-lesson`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ lessonId: lesson1.id })
      .expect(201);
    const second = await request(app.getHttpServer())
      .post(`/courses/${course.id}/progress/complete-lesson`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ lessonId: lesson1.id })
      .expect(201);

    expect(second.body.completedLessons).toBe(1);
  });

  it('completing every lesson marks the course completed, certificate eligible, and the enrollment itself completed', async () => {
    const { course, lesson1, lesson2 } =
      await seedEnrollableCourseWithLessons('progress-complete');
    const student = await signUpAndSignIn(app, 'progress-complete-student');
    await seedAcademyStudent(admin, course.academyId, student.userId);
    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ courseId: course.id })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/courses/${course.id}/progress/complete-lesson`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ lessonId: lesson1.id })
      .expect(201);
    const final = await request(app.getHttpServer())
      .post(`/courses/${course.id}/progress/complete-lesson`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ lessonId: lesson2.id })
      .expect(201);

    expect(final.body.completionState).toBe('completed');
    expect(final.body.certificateStatus).toBe('eligible');
    expect(final.body.percentage).toBe(100);

    const enrollment = await request(app.getHttpServer())
      .get(`/enrollments/by-course/${course.id}`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);
    expect(enrollment.body.status).toBe('completed');
    expect(enrollment.body.completedAt).toBeTruthy();
  });

  it('rejects completing a lesson from a different course', async () => {
    const { course: courseA } = await seedEnrollableCourseWithLessons('progress-crossA');
    const { lesson1: foreignLesson } =
      await seedEnrollableCourseWithLessons('progress-crossB');
    const student = await signUpAndSignIn(app, 'progress-cross-student');
    await seedAcademyStudent(admin, courseA.academyId, student.userId);
    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ courseId: courseA.id })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/courses/${courseA.id}/progress/complete-lesson`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ lessonId: foreignLesson.id })
      .expect(404);
  });
});
