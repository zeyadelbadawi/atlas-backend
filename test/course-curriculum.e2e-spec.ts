/**
 * Course Curriculum (sections/lessons) — functional/contract e2e suite
 * (P5). Covers CRUD, the explicit move-up/move-down reorder model, and
 * ownership-chain verification (Lesson → Section → Course → Academy →
 * Organization — master plan P5 §14).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedCourse,
  seedCourseSection,
  seedCourseLesson,
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

async function seedManagedAcademy(
  admin: PrismaClient,
  organizationId: string,
  ownerUserId: string,
  label: string,
) {
  const academy = await seedAcademy(admin, organizationId, label);
  await seedAcademyMember(admin, academy.id, ownerUserId, 'owner');
  return academy;
}

describe('Course Curriculum — sections/lessons (e2e)', () => {
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

  it('creating sections auto-assigns sequential order, and GET returns them in order with nested lessons', async () => {
    const owner = await signUpAndSignIn(app, 'curriculum-order');
    const org = await seedOrganizationWithOwner(
      admin,
      owner.userId,
      'curriculum-order-org',
    );
    const academy = await seedManagedAcademy(
      admin,
      org.id,
      owner.userId,
      'curriculum-order-academy',
    );
    const course = await seedCourse(admin, academy.id, 'Curriculum Order Course');

    const s1 = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses/${course.id}/sections`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'First' })
      .expect(201);
    expect(s1.body.order).toBe(0);

    const s2 = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses/${course.id}/sections`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Second' })
      .expect(201);
    expect(s2.body.order).toBe(1);

    const lesson = await request(app.getHttpServer())
      .post(
        `/academies/${academy.id}/courses/${course.id}/sections/${s1.body.id}/lessons`,
      )
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'A Lesson', contentType: 'text' })
      .expect(201);
    expect(lesson.body.order).toBe(0);
    expect(lesson.body.courseId).toBe(course.id);

    const sections = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/courses/${course.id}/sections`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(sections.body.items.map((s: { id: string }) => s.id)).toEqual([
      s1.body.id,
      s2.body.id,
    ]);
    expect(sections.body.items[0].lessons.map((l: { id: string }) => l.id)).toEqual([
      lesson.body.id,
    ]);
  });

  it('reorderSections persists the full new order (explicit move-up/move-down semantics, not drag-and-drop)', async () => {
    const owner = await signUpAndSignIn(app, 'curriculum-reorder');
    const org = await seedOrganizationWithOwner(
      admin,
      owner.userId,
      'curriculum-reorder-org',
    );
    const academy = await seedManagedAcademy(
      admin,
      org.id,
      owner.userId,
      'curriculum-reorder-academy',
    );
    const course = await seedCourse(admin, academy.id, 'Reorder Course');
    const s1 = await seedCourseSection(admin, course.id, 'First', 0);
    const s2 = await seedCourseSection(admin, course.id, 'Second', 1);
    const s3 = await seedCourseSection(admin, course.id, 'Third', 2);

    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/courses/${course.id}/sections/order`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ orderedIds: [s3.id, s1.id, s2.id] })
      .expect(204);

    const rows = await admin.courseSection.findMany({
      where: { courseId: course.id },
      orderBy: { order: 'asc' },
    });
    expect(rows.map((r) => r.id)).toEqual([s3.id, s1.id, s2.id]);
    expect(rows.map((r) => r.order)).toEqual([0, 1, 2]);
  });

  it('reorderSections rejects a set that does not exactly match the current sections (missing/extra/foreign id) with 400', async () => {
    const owner = await signUpAndSignIn(app, 'curriculum-reorder-invalid');
    const org = await seedOrganizationWithOwner(
      admin,
      owner.userId,
      'curriculum-reorder-invalid-org',
    );
    const academy = await seedManagedAcademy(
      admin,
      org.id,
      owner.userId,
      'curriculum-reorder-invalid-academy',
    );
    const course = await seedCourse(admin, academy.id, 'Reorder Invalid Course');
    const s1 = await seedCourseSection(admin, course.id, 'First', 0);
    await seedCourseSection(admin, course.id, 'Second', 1);

    // Missing s2, and a foreign id smuggled in.
    const response = await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/courses/${course.id}/sections/order`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ orderedIds: [s1.id, 'not-a-real-id'] });
    expect(response.status).toBe(400);
  });

  it('reorderLessons persists the full new order within one section', async () => {
    const owner = await signUpAndSignIn(app, 'curriculum-reorder-lessons');
    const org = await seedOrganizationWithOwner(
      admin,
      owner.userId,
      'curriculum-reorder-lessons-org',
    );
    const academy = await seedManagedAcademy(
      admin,
      org.id,
      owner.userId,
      'curriculum-reorder-lessons-academy',
    );
    const course = await seedCourse(admin, academy.id, 'Reorder Lessons Course');
    const section = await seedCourseSection(admin, course.id, 'Section', 0);
    const l1 = await seedCourseLesson(admin, section.id, course.id, 'First', 0);
    const l2 = await seedCourseLesson(admin, section.id, course.id, 'Second', 1);

    await request(app.getHttpServer())
      .patch(
        `/academies/${academy.id}/courses/${course.id}/sections/${section.id}/lessons/order`,
      )
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ orderedIds: [l2.id, l1.id] })
      .expect(204);

    const rows = await admin.courseLesson.findMany({
      where: { sectionId: section.id },
      orderBy: { order: 'asc' },
    });
    expect(rows.map((r) => r.id)).toEqual([l2.id, l1.id]);
  });

  it('updateSection/deleteSection 404 when the section does not belong to the given course (ownership-chain check)', async () => {
    const owner = await signUpAndSignIn(app, 'curriculum-chain-section');
    const org = await seedOrganizationWithOwner(
      admin,
      owner.userId,
      'curriculum-chain-section-org',
    );
    const academy = await seedManagedAcademy(
      admin,
      org.id,
      owner.userId,
      'curriculum-chain-section-academy',
    );
    const courseA = await seedCourse(admin, academy.id, 'Course A');
    const courseB = await seedCourse(admin, academy.id, 'Course B');
    const sectionOfB = await seedCourseSection(admin, courseB.id, 'Belongs to B', 0);

    // Same academy, same organization, correct guard pass — but the
    // section belongs to a DIFFERENT course than the one in the URL.
    const updateResponse = await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/courses/${courseA.id}/sections/${sectionOfB.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Should not apply' });
    expect(updateResponse.status).toBe(404);

    const deleteResponse = await request(app.getHttpServer())
      .delete(`/academies/${academy.id}/courses/${courseA.id}/sections/${sectionOfB.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(deleteResponse.status).toBe(404);

    const stillExists = await admin.courseSection.findUnique({
      where: { id: sectionOfB.id },
    });
    expect(stillExists).not.toBeNull();
  });

  it('updateLesson/deleteLesson 404 when the lesson does not belong to the given section (full chain: lesson -> section -> course)', async () => {
    const owner = await signUpAndSignIn(app, 'curriculum-chain-lesson');
    const org = await seedOrganizationWithOwner(
      admin,
      owner.userId,
      'curriculum-chain-lesson-org',
    );
    const academy = await seedManagedAcademy(
      admin,
      org.id,
      owner.userId,
      'curriculum-chain-lesson-academy',
    );
    const course = await seedCourse(admin, academy.id, 'Chain Lesson Course');
    const sectionA = await seedCourseSection(admin, course.id, 'Section A', 0);
    const sectionB = await seedCourseSection(admin, course.id, 'Section B', 1);
    const lessonOfB = await seedCourseLesson(
      admin,
      sectionB.id,
      course.id,
      'Belongs to Section B',
      0,
    );

    const updateResponse = await request(app.getHttpServer())
      .patch(
        `/academies/${academy.id}/courses/${course.id}/sections/${sectionA.id}/lessons/${lessonOfB.id}`,
      )
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Should not apply' });
    expect(updateResponse.status).toBe(404);

    const deleteResponse = await request(app.getHttpServer())
      .delete(
        `/academies/${academy.id}/courses/${course.id}/sections/${sectionA.id}/lessons/${lessonOfB.id}`,
      )
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(deleteResponse.status).toBe(404);
  });

  it('deleteSection cascades to its lessons', async () => {
    const owner = await signUpAndSignIn(app, 'curriculum-cascade');
    const org = await seedOrganizationWithOwner(
      admin,
      owner.userId,
      'curriculum-cascade-org',
    );
    const academy = await seedManagedAcademy(
      admin,
      org.id,
      owner.userId,
      'curriculum-cascade-academy',
    );
    const course = await seedCourse(admin, academy.id, 'Cascade Course');
    const section = await seedCourseSection(admin, course.id, 'Section', 0);
    const lesson = await seedCourseLesson(admin, section.id, course.id, 'Lesson', 0);

    await request(app.getHttpServer())
      .delete(`/academies/${academy.id}/courses/${course.id}/sections/${section.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(204);

    const lessonStillExists = await admin.courseLesson.findUnique({
      where: { id: lesson.id },
    });
    expect(lessonStillExists).toBeNull();
  });

  it('write operations on sections/lessons are denied for an org member with no academy_members role', async () => {
    const owner = await signUpAndSignIn(app, 'curriculum-write-owner');
    const orgMemberOnly = await signUpAndSignIn(app, 'curriculum-write-member');
    const org = await seedOrganizationWithOwner(
      admin,
      owner.userId,
      'curriculum-write-org',
    );
    await admin.organizationMembership.create({
      data: { organizationId: org.id, userId: orgMemberOnly.userId, role: 'member' },
    });
    const academy = await seedManagedAcademy(
      admin,
      org.id,
      owner.userId,
      'curriculum-write-academy',
    );
    const course = await seedCourse(admin, academy.id, 'Curriculum Write Test');

    const response = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses/${course.id}/sections`)
      .set('Authorization', `Bearer ${orgMemberOnly.accessToken}`)
      .send({ title: 'Should not be created' });
    expect(response.status).toBe(403);
  });
});
