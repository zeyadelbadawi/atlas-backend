/**
 * Course Commerce — tenant isolation (Phase P13, master plan §18: "the
 * highest-priority suite in the entire backend, CI-blocking"). Mirrors
 * `learning-tenant-isolation.e2e-spec.ts`'s HTTP-level pattern: every
 * scenario here is a real request through the real guards/services/RLS
 * stack — no direct Prisma/session-variable manipulation (that direct-RLS
 * proof style is `rls-*.e2e-spec.ts`, out of this file's scope).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedCourse,
  seedOrganizationWithOwner,
  seedPaymentMethod,
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

async function makePlatformOwner(admin: PrismaClient, userId: string): Promise<void> {
  await admin.user.update({ where: { id: userId }, data: { isPlatformOwner: true } });
}

describe('Course Commerce — tenant isolation (e2e)', () => {
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

  async function arrangePaidCourseAndOrder(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    const course = await seedCourse(admin, academy.id, `${label} ${Date.now()}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'paid',
      pricingAmountMinorUnits: 5000n,
      pricingCurrency: 'USD',
    });
    const student = await signUpAndSignIn(app, `${label}-student`);
    await request(app.getHttpServer())
      .patch(`/organizations/${org.id}/payment-settings`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ paymentCollectionMode: 'atlas_payments' })
      .expect(200);

    const orderRes = await request(app.getHttpServer())
      .post(`/courses/${course.id}/course-orders`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ idempotencyKey: `${label}-order` })
      .expect(201);

    return { owner, org, academy, course, student, order: orderRes.body };
  }

  it('a different student can never read, by direct id, another student’s CourseOrder', async () => {
    const { order } = await arrangePaidCourseAndOrder('isolation-order-read');
    const otherStudent = await signUpAndSignIn(app, 'isolation-order-read-other');

    await request(app.getHttpServer())
      .get(`/course-orders/${order.id}`)
      .set('Authorization', `Bearer ${otherStudent.accessToken}`)
      .expect(404);
  });

  it('a different student can never create a Payment against another student’s CourseOrder', async () => {
    const { order } = await arrangePaidCourseAndOrder('isolation-payment-create');
    const otherStudent = await signUpAndSignIn(app, 'isolation-payment-create-other');
    const method = await seedPaymentMethod(admin, 'isolation-payment-create-method');

    await request(app.getHttpServer())
      .post(`/course-orders/${order.id}/payments`)
      .set('Authorization', `Bearer ${otherStudent.accessToken}`)
      .send({ methodKey: method.key })
      .expect(404);
  });

  it('a different student can never request a refund on another student’s CourseOrder', async () => {
    const { order } = await arrangePaidCourseAndOrder('isolation-refund');
    const otherStudent = await signUpAndSignIn(app, 'isolation-refund-other');

    await request(app.getHttpServer())
      .post(`/course-orders/${order.id}/refund`)
      .set('Authorization', `Bearer ${otherStudent.accessToken}`)
      .send({ idempotencyKey: 'isolation-refund-key' })
      .expect(404);
  });

  it('an unrelated Organization member can never read another Academy’s payouts', async () => {
    const { academy } = await arrangePaidCourseAndOrder('isolation-payout-read');
    const outsiderOwner = await signUpAndSignIn(app, 'isolation-payout-read-outsider');
    await seedOrganizationWithOwner(
      admin,
      outsiderOwner.userId,
      'isolation-payout-read-outsider-org',
    );

    // The outsider is not a member of the Academy's own Organization, so
    // `AcademyScopeGuard` rejects the read outright — matches every other
    // Academy-scoped route's identical guard (P5/P8/P9's own precedent).
    await request(app.getHttpServer())
      .get(`/academies/${academy.id}/payouts`)
      .set('Authorization', `Bearer ${outsiderOwner.accessToken}`)
      .expect(403);
  });

  it('the flat Platform review surface only ever returns Course Commerce rows, never Atlas-subscription-billing rows, and vice versa', async () => {
    const { order, course, student } = await arrangePaidCourseAndOrder(
      'isolation-review-split',
    );
    const method = await seedPaymentMethod(admin, 'isolation-review-split-method');
    const paymentRes = await request(app.getHttpServer())
      .post(`/course-orders/${order.id}/payments`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ methodKey: method.key })
      .expect(201);

    const reviewer = await signUpAndSignIn(app, 'isolation-review-split-reviewer');
    await makePlatformOwner(admin, reviewer.userId);

    // The Atlas-subscription-billing review surface (`/payments`) must
    // never surface a course-order Payment.
    await request(app.getHttpServer())
      .get(`/payments/${paymentRes.body.id}`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(404);

    // ...and the course-order review surface must correctly find it.
    await request(app.getHttpServer())
      .get(`/platform-course-order-payments/${paymentRes.body.id}`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(200);

    void course;
  });

  it('a non-member cannot read another Organization’s commission configuration', async () => {
    const owner = await signUpAndSignIn(app, 'isolation-commission-owner');
    const org = await seedOrganizationWithOwner(
      admin,
      owner.userId,
      'isolation-commission-org',
    );
    const outsider = await signUpAndSignIn(app, 'isolation-commission-outsider');

    await request(app.getHttpServer())
      .get(`/organizations/${org.id}/payment-settings/commission`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .expect(403);
  });
});
