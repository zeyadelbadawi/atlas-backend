/**
 * Enrollment — `EnrollmentService` (P6, master plan §21). Free-course-only
 * (§3/§21's explicit "no payment gate yet" instruction) — a paid course's
 * enrollment attempt must be rejected outright, never granted for free.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedActiveSubscriptionForOrg,
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

/** Phase 1 (Extended Scope, Decision 11, dependency D) — a real, Academy-scoped student, the same shape a public Academy website's Sign Up page produces. */
async function signUpStudentForAcademy(
  app: INestApplication,
  label: string,
  academyId: string,
): Promise<{ userId: string; accessToken: string }> {
  const email = uniqueTestEmail(label);
  const password = 'correct-horse-battery';
  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ name: label, email, password, academyId })
    .expect(201);
  const signIn = await request(app.getHttpServer())
    .post('/auth/sign-in')
    .send({ email, password })
    .expect(200);
  return { userId: signIn.body.user.id, accessToken: signIn.body.accessToken };
}

describe('Enrollment (e2e)', () => {
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

  it('requires authentication on every route', async () => {
    await request(app.getHttpServer()).get('/enrollments').expect(401);
    await request(app.getHttpServer()).post('/enrollments').send({}).expect(401);
    await request(app.getHttpServer()).get('/enrollments/by-course/x').expect(401);
  });

  it('getEnrollmentForCourse returns null (not 404) before enrolling', async () => {
    const owner = await signUpAndSignIn(app, 'enroll-null-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'enroll-null-org');
    const academy = await seedAcademy(admin, org.id, 'enroll-null-academy');
    const course = await seedCourse(admin, academy.id, `Null ${Date.now()}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });

    const student = await signUpAndSignIn(app, 'enroll-null-student');
    const response = await request(app.getHttpServer())
      .get(`/enrollments/by-course/${course.id}`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);
    expect(response.body).toBeNull();
  });

  it('enrolls a student in a free, published, public course', async () => {
    const owner = await signUpAndSignIn(app, 'enroll-free-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'enroll-free-org');
    await seedActiveSubscriptionForOrg(admin, org.id, 'enroll-free');
    const academy = await seedAcademy(admin, org.id, 'enroll-free-academy');
    const course = await seedCourse(admin, academy.id, `Free ${Date.now()}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });

    const student = await signUpStudentForAcademy(app, 'enroll-free-student', academy.id);
    const created = await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ courseId: course.id })
      .expect(201);

    expect(created.body).toMatchObject({
      studentId: student.userId,
      courseId: course.id,
      academyId: academy.id,
      status: 'enrolled',
    });
    expect(created.body.enrolledAt).toBeTruthy();

    const fetched = await request(app.getHttpServer())
      .get(`/enrollments/by-course/${course.id}`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);
    expect(fetched.body.id).toBe(created.body.id);

    const list = await request(app.getHttpServer())
      .get('/enrollments')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);
    expect(list.body.items.map((e: { id: string }) => e.id)).toContain(created.body.id);
  });

  it('is idempotent — re-enrolling in an already-enrolled course returns the existing enrollment, not an error', async () => {
    const owner = await signUpAndSignIn(app, 'enroll-idempotent-owner');
    const org = await seedOrganizationWithOwner(
      admin,
      owner.userId,
      'enroll-idempotent-org',
    );
    await seedActiveSubscriptionForOrg(admin, org.id, 'enroll-idempotent');
    const academy = await seedAcademy(admin, org.id, 'enroll-idempotent-academy');
    const course = await seedCourse(admin, academy.id, `Idempotent ${Date.now()}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });

    const student = await signUpStudentForAcademy(
      app,
      'enroll-idempotent-student',
      academy.id,
    );
    const first = await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ courseId: course.id })
      .expect(201);
    const second = await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ courseId: course.id })
      .expect(201);

    expect(second.body.id).toBe(first.body.id);
  });

  it('rejects enrollment in a paid course — no purchase flow exists yet, never grants free access', async () => {
    const owner = await signUpAndSignIn(app, 'enroll-paid-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'enroll-paid-org');
    const academy = await seedAcademy(admin, org.id, 'enroll-paid-academy');
    const paidCourse = await seedCourse(admin, academy.id, `Paid ${Date.now()}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'paid',
      pricingAmountMinorUnits: 4999n,
      pricingCurrency: 'USD',
    });

    const student = await signUpAndSignIn(app, 'enroll-paid-student');
    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ courseId: paidCourse.id })
      .expect(403);

    const fetched = await request(app.getHttpServer())
      .get(`/enrollments/by-course/${paidCourse.id}`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);
    expect(fetched.body).toBeNull();
  });

  it('rejects enrollment in a draft/unpublished course', async () => {
    const owner = await signUpAndSignIn(app, 'enroll-draft-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'enroll-draft-org');
    const academy = await seedAcademy(admin, org.id, 'enroll-draft-academy');
    const draft = await seedCourse(admin, academy.id, `Draft ${Date.now()}`, {
      status: 'draft',
      visibility: 'public',
      pricingType: 'free',
    });

    const student = await signUpAndSignIn(app, 'enroll-draft-student');
    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ courseId: draft.id })
      .expect(404);
  });

  it('rejects a nonexistent courseId', async () => {
    const student = await signUpAndSignIn(app, 'enroll-missing-student');
    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ courseId: '00000000-0000-0000-0000-000000000000' })
      .expect(404);
  });

  /* ------- Phase 1 (Extended Scope, Decision 11, dependency D) ------- */

  it('rejects enrollment for a student with no Academy membership at all — a clean 403, never a raw RLS 500', async () => {
    const owner = await signUpAndSignIn(app, 'enroll-no-academy-owner');
    const org = await seedOrganizationWithOwner(
      admin,
      owner.userId,
      'enroll-no-academy-org',
    );
    const academy = await seedAcademy(admin, org.id, 'enroll-no-academy-academy');
    const course = await seedCourse(admin, academy.id, `NoAcademy ${Date.now()}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });

    // Registered through no Academy website at all (the self-service
    // Organization-Owner onboarding journey shape) — has no
    // `academy_students` row anywhere.
    const student = await signUpAndSignIn(app, 'enroll-no-academy-student');
    const response = await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ courseId: course.id })
      .expect(403);
    expect(response.body.error.messageKey).toBe(
      'errors.enrollment.academyMembershipRequired',
    );
  });

  it("rejects enrollment for a student registered through a DIFFERENT Academy's website — Academy A membership never grants Academy B course access", async () => {
    const ownerA = await signUpAndSignIn(app, 'enroll-cross-academy-owner-a');
    const orgA = await seedOrganizationWithOwner(
      admin,
      ownerA.userId,
      'enroll-cross-academy-org-a',
    );
    const academyA = await seedAcademy(admin, orgA.id, 'enroll-cross-academy-academy-a');

    const ownerB = await signUpAndSignIn(app, 'enroll-cross-academy-owner-b');
    const orgB = await seedOrganizationWithOwner(
      admin,
      ownerB.userId,
      'enroll-cross-academy-org-b',
    );
    const academyB = await seedAcademy(admin, orgB.id, 'enroll-cross-academy-academy-b');
    const courseB = await seedCourse(admin, academyB.id, `CrossAcademy ${Date.now()}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });

    const studentOfA = await signUpStudentForAcademy(
      app,
      'enroll-cross-academy-student',
      academyA.id,
    );

    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${studentOfA.accessToken}`)
      .send({ courseId: courseB.id })
      .expect(403);
  });
});
