/**
 * P64 Phase 4 — adversarial pass over the surfaces this phase added.
 *
 * Deliberately NOT a second copy of the happy-path suites. Each case here
 * is an attempt to get something the product must never give up, chosen
 * for the surfaces Phase 4 introduced or widened: course reviews, the
 * catalog v2 filters, course-order checkout, and the owner reports.
 *
 * Where an existing suite already proves a control (cross-academy review
 * isolation, report role gates, the video-metrics owner gate) it is not
 * repeated. What is new here is the class of attack those suites do not
 * make: forging server-owned fields, using a filter as an exfiltration
 * primitive, and reaching another buyer's money objects by id.
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

describe('P64 Phase 4 — adversarial (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;

    const owner = await signUpAndSignIn(app, `p64adv-commission-${Date.now()}`);
    await admin.user.update({
      where: { id: owner.userId },
      data: { isPlatformOwner: true },
    });
    await request(app.getHttpServer())
      .patch('/platform-commission/global')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ defaultCommissionBasisPoints: 1000 })
      .expect(200);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function seedAcademyWithCourse(
    label: string,
    courseOverrides: Record<string, unknown> = {},
  ) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const course = await seedCourse(admin, academy.id, `${label}-course`, {
      status: 'published',
      visibility: 'public',
      ...courseOverrides,
    });
    return { owner, org, academy, course };
  }

  async function seedEnrolledLearner(label: string, academyId: string, courseId: string) {
    const learner = await signUpAndSignIn(app, label);
    await seedAcademyStudent(admin, academyId, learner.userId);
    await seedEnrollment(admin, learner.userId, courseId, academyId, {
      status: 'enrolled',
    });
    return learner;
  }

  // --- 1. Server-owned fields cannot be forged ---------------------------

  it('a learner cannot publish their own review by sending a status the DTO does not own', async () => {
    const { academy, course } = await seedAcademyWithCourse('adv-forge');
    const learner = await seedEnrolledLearner('adv-forge-learner', academy.id, course.id);

    // `forbidNonWhitelisted` is the control. Asserting it here means a
    // later relaxation of the global pipe fails a test instead of
    // silently handing moderation to the author.
    await request(app.getHttpServer())
      .post(`/courses/${course.id}/reviews`)
      .set(auth(learner.accessToken))
      .send({ rating: 5, body: 'self-approved', status: 'approved' })
      .expect(400);

    // And nothing was written on the way to the rejection.
    const mine = await request(app.getHttpServer())
      .get(`/courses/${course.id}/reviews/mine`)
      .set(auth(learner.accessToken));
    expect([200, 404]).toContain(mine.status);
    if (mine.status === 200) expect(mine.body).toBeNull();
  });

  it('a buyer cannot set the price of their own order', async () => {
    const { org, owner, course } = await seedAcademyWithCourse('adv-price', {
      pricingType: 'paid',
      pricingAmountMinorUnits: BigInt(9900),
      pricingCurrency: 'USD',
    });
    await request(app.getHttpServer())
      .patch(`/organizations/${org.id}/payment-settings`)
      .set(auth(owner.accessToken))
      .send({ paymentCollectionMode: 'atlas_payments' })
      .expect(200);
    const buyer = await signUpAndSignIn(app, 'adv-price-buyer');

    await request(app.getHttpServer())
      .post(`/courses/${course.id}/course-orders`)
      .set(auth(buyer.accessToken))
      .send({ idempotencyKey: 'adv-price-1', amountMinorUnits: 1, price: 1 })
      .expect(400);

    // The honest order still prices itself from the course.
    const order = await request(app.getHttpServer())
      .post(`/courses/${course.id}/course-orders`)
      .set(auth(buyer.accessToken))
      .send({ idempotencyKey: 'adv-price-2' })
      .expect(201);
    expect(order.body.snapshot.price.amountMinorUnits).toBe(9900);
  });

  // --- 2. Filters are not an exfiltration primitive ----------------------

  it('the catalog ids filter cannot surface a course the catalog would not list', async () => {
    const { academy } = await seedAcademyWithCourse('adv-ids');
    const draft = await seedCourse(admin, academy.id, 'adv-ids-draft', {
      status: 'draft',
      visibility: 'public',
    });
    const privatePublished = await seedCourse(admin, academy.id, 'adv-ids-private', {
      status: 'published',
      visibility: 'private',
    });

    for (const hidden of [draft, privatePublished]) {
      const res = await request(app.getHttpServer())
        .get(`/public/websites/${academy.id}/courses`)
        .query({ ids: hidden.id })
        .expect(200);
      expect(res.body.items).toEqual([]);
    }
  });

  it('a course of another academy cannot be pulled into this academy’s catalog by id', async () => {
    const a = await seedAcademyWithCourse('adv-xacad-a');
    const b = await seedAcademyWithCourse('adv-xacad-b');

    const res = await request(app.getHttpServer())
      .get(`/public/websites/${a.academy.id}/courses`)
      .query({ ids: b.course.id })
      .expect(200);
    expect(res.body.items).toEqual([]);
  });

  it('a pending review is invisible on the public surface and does not move the rating', async () => {
    const { academy, course } = await seedAcademyWithCourse('adv-pending');
    const learner = await seedEnrolledLearner('adv-pending-l', academy.id, course.id);
    await request(app.getHttpServer())
      .post(`/courses/${course.id}/reviews`)
      .set(auth(learner.accessToken))
      .send({ rating: 5, body: 'not yet moderated' })
      .expect(201);

    const list = await request(app.getHttpServer())
      .get(`/public/websites/${academy.id}/courses/${course.id}/reviews`)
      .expect(200);
    expect(list.body.items).toEqual([]);
    expect(JSON.stringify(list.body)).not.toContain('not yet moderated');

    const rating = await request(app.getHttpServer())
      .get(`/public/websites/${academy.id}/courses/${course.id}/rating`)
      .expect(200);
    expect(rating.body.averageRating).toBe(0);
    expect(rating.body.totalReviews).toBe(0);
  });

  // --- 3. Another buyer's money objects are unreachable by id ------------

  it('a stranger cannot read, pay, or list methods for someone else’s order', async () => {
    const { org, owner, course } = await seedAcademyWithCourse('adv-idor', {
      pricingType: 'paid',
      pricingAmountMinorUnits: BigInt(4900),
      pricingCurrency: 'USD',
    });
    await request(app.getHttpServer())
      .patch(`/organizations/${org.id}/payment-settings`)
      .set(auth(owner.accessToken))
      .send({ paymentCollectionMode: 'atlas_payments' })
      .expect(200);
    const method = await seedPaymentMethod(admin, 'adv-idor-method');

    const buyer = await signUpAndSignIn(app, 'adv-idor-buyer');
    const order = await request(app.getHttpServer())
      .post(`/courses/${course.id}/course-orders`)
      .set(auth(buyer.accessToken))
      .send({ idempotencyKey: 'adv-idor-1' })
      .expect(201);
    const payment = await request(app.getHttpServer())
      .post(`/course-orders/${order.body.id}/payments`)
      .set(auth(buyer.accessToken))
      .send({ methodKey: method.key })
      .expect(201);

    const stranger = await signUpAndSignIn(app, 'adv-idor-stranger');
    const h = auth(stranger.accessToken);

    await request(app.getHttpServer())
      .get(`/course-orders/${order.body.id}`)
      .set(h)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/course-orders/${order.body.id}/payment-methods`)
      .set(h)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/course-orders/${order.body.id}/payments/${payment.body.id}`)
      .set(h)
      .expect(404);
    await request(app.getHttpServer())
      .post(`/course-orders/${order.body.id}/payments`)
      .set(h)
      .send({ methodKey: method.key })
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/course-orders/${order.body.id}/payments/${payment.body.id}/proof`)
      .set(h)
      .send({
        fileData:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        fileName: 'stolen.png',
      })
      .expect(404);
  });

  it('a buyer cannot approve their own payment', async () => {
    const { org, owner, course } = await seedAcademyWithCourse('adv-selfapprove', {
      pricingType: 'paid',
      pricingAmountMinorUnits: BigInt(4900),
      pricingCurrency: 'USD',
    });
    await request(app.getHttpServer())
      .patch(`/organizations/${org.id}/payment-settings`)
      .set(auth(owner.accessToken))
      .send({ paymentCollectionMode: 'atlas_payments' })
      .expect(200);
    const method = await seedPaymentMethod(admin, 'adv-selfapprove-method');

    const buyer = await signUpAndSignIn(app, 'adv-selfapprove-buyer');
    const order = await request(app.getHttpServer())
      .post(`/courses/${course.id}/course-orders`)
      .set(auth(buyer.accessToken))
      .send({ idempotencyKey: 'adv-selfapprove-1' })
      .expect(201);
    const payment = await request(app.getHttpServer())
      .post(`/course-orders/${order.body.id}/payments`)
      .set(auth(buyer.accessToken))
      .send({ methodKey: method.key })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/platform-course-order-payments/${payment.body.id}/approve`)
      .set(auth(buyer.accessToken))
      .send({})
      .expect(403);

    // And no enrolment appeared as a side effect of trying.
    const enrolment = await admin.enrollment.findFirst({
      where: { studentId: buyer.userId, courseId: course.id },
    });
    expect(enrolment).toBeNull();
  });

  // --- 4. Reports never become a PII channel -----------------------------

  it('the owner reports refuse a learner of the same academy', async () => {
    const { academy, course } = await seedAcademyWithCourse('adv-reports');
    const learner = await seedEnrolledLearner('adv-reports-l', academy.id, course.id);

    for (const report of ['integrity', 'sharing']) {
      const res = await request(app.getHttpServer())
        .get(`/academies/${academy.id}/reports/${report}`)
        .set(auth(learner.accessToken));
      expect([403, 404]).toContain(res.status);
    }
  });
});
