/**
 * Assignments — `AssignmentService` (P6, master plan §21). No write
 * endpoint for assignments themselves (seeded via the admin connection).
 * `(assignment_id, student_id)` stays unconditionally unique — a
 * resubmission updates the same row in place; no history table (see
 * `schema.prisma`'s P6 header comment).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAssignment,
  seedCourse,
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

describe('Assignments (e2e)', () => {
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

  async function seedEnrolledStudentWithAssignment(
    label: string,
    overrides: { allowResubmission?: boolean } = {},
  ) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    const course = await seedCourse(admin, academy.id, `${label}-course-${Date.now()}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    const assignment = await seedAssignment(admin, course.id, `${label} assignment`, {
      status: 'published',
      allowResubmission: overrides.allowResubmission ?? false,
    });

    const student = await signUpAndSignIn(app, `${label}-student`);
    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ courseId: course.id })
      .expect(201);

    return { course, assignment, student };
  }

  it('requires authentication', async () => {
    await request(app.getHttpServer()).get('/courses/x/assignments').expect(401);
  });

  it('getSubmission returns null (not 404) before submitting', async () => {
    const { course, assignment, student } =
      await seedEnrolledStudentWithAssignment('assignment-null');
    const response = await request(app.getHttpServer())
      .get(`/courses/${course.id}/assignments/${assignment.id}/submission`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);
    expect(response.body).toBeNull();
  });

  it('lists and reads published assignments for an enrolled student', async () => {
    const { course, assignment, student } =
      await seedEnrolledStudentWithAssignment('assignment-read');
    const list = await request(app.getHttpServer())
      .get(`/courses/${course.id}/assignments`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);
    expect(list.body.items.map((a: { id: string }) => a.id)).toContain(assignment.id);

    const single = await request(app.getHttpServer())
      .get(`/courses/${course.id}/assignments/${assignment.id}`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);
    expect(single.body.id).toBe(assignment.id);
  });

  it('submits a response and it is readable back', async () => {
    const { course, assignment, student } =
      await seedEnrolledStudentWithAssignment('assignment-submit');
    const submitted = await request(app.getHttpServer())
      .post(`/courses/${course.id}/assignments/${assignment.id}/submission`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ response: 'My real answer.' })
      .expect(201);

    expect(submitted.body).toMatchObject({
      assignmentId: assignment.id,
      studentId: student.userId,
      status: 'submitted',
      response: 'My real answer.',
    });
    expect(submitted.body.submittedAt).toBeTruthy();

    const fetched = await request(app.getHttpServer())
      .get(`/courses/${course.id}/assignments/${assignment.id}/submission`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);
    expect(fetched.body.id).toBe(submitted.body.id);
  });

  it("rejects a submission with neither a response nor an attachment — mirrors the frontend's own required-one-of-two rule", async () => {
    const { course, assignment, student } =
      await seedEnrolledStudentWithAssignment('assignment-empty');
    await request(app.getHttpServer())
      .post(`/courses/${course.id}/assignments/${assignment.id}/submission`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({})
      .expect(400);
  });

  it('accepts a submission with only an attachment, no response text', async () => {
    const { course, assignment, student } = await seedEnrolledStudentWithAssignment(
      'assignment-attachment-only',
    );
    const submitted = await request(app.getHttpServer())
      .post(`/courses/${course.id}/assignments/${assignment.id}/submission`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ attachmentUrl: 'https://example.com/file.pdf' })
      .expect(201);
    expect(submitted.body.attachmentUrl).toBe('https://example.com/file.pdf');
  });

  it('rejects a second submission when allowResubmission is false', async () => {
    const { course, assignment, student } = await seedEnrolledStudentWithAssignment(
      'assignment-noresubmit',
      { allowResubmission: false },
    );
    await request(app.getHttpServer())
      .post(`/courses/${course.id}/assignments/${assignment.id}/submission`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ response: 'First.' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/courses/${course.id}/assignments/${assignment.id}/submission`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ response: 'Second.' })
      .expect(409);
  });

  it('allows a resubmission in place when allowResubmission is true, replacing the prior content', async () => {
    const { course, assignment, student } = await seedEnrolledStudentWithAssignment(
      'assignment-resubmit',
      { allowResubmission: true },
    );
    const first = await request(app.getHttpServer())
      .post(`/courses/${course.id}/assignments/${assignment.id}/submission`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ response: 'First.' })
      .expect(201);
    const second = await request(app.getHttpServer())
      .post(`/courses/${course.id}/assignments/${assignment.id}/submission`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ response: 'Second, replacing the first.' })
      .expect(201);

    expect(second.body.id).toBe(first.body.id); // same row, kept in place
    expect(second.body.response).toBe('Second, replacing the first.');
  });
});
