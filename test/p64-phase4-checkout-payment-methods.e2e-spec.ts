/**
 * P64 Phase 4 — the learner checkout's payment-method list
 * (`GET /course-orders/:id/payment-methods`).
 *
 * Why this endpoint exists at all: the checkout page used to read the
 * PLATFORM catalog at `GET /payment-methods`, which sits behind
 * `ManagementSurfaceGuard`. A learner asking it gets
 * `errors.auth.managementSurfaceOnly`, so the page fell back to its
 * "not available for purchase yet" state for every learner no matter
 * what the academy had configured — student checkout could not be
 * completed by anyone. Found by the J6 Playwright journey in a real
 * browser, not by any unit test.
 *
 * The behaviour worth protecting is the AGREEMENT: a method this
 * endpoint offers is one `POST :id/payments` accepts, and a method it
 * hides is one that route would refuse. The last case below proves that
 * agreement rather than asserting the two lists separately.
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

describe('P64 Phase 4 — learner checkout payment methods (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;

    // Atlas Payments refuses outright rather than guessing 0%, so a
    // resolvable commission is a precondition for every case that
    // expects methods to be offered at all.
    const owner = await signUpAndSignIn(app, `p64-pm-commission-${Date.now()}`);
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

  /** A paid published course, a student, and an open order for it. */
  async function arrangeOrder(label: string, atlasPayments = true) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    const course = await seedCourse(admin, academy.id, `${label} Course ${Date.now()}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'paid',
      pricingAmountMinorUnits: BigInt(4900),
      pricingCurrency: 'USD',
    });
    if (atlasPayments) {
      await request(app.getHttpServer())
        .patch(`/organizations/${org.id}/payment-settings`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ paymentCollectionMode: 'atlas_payments' })
        .expect(200);
    }
    const student = await signUpAndSignIn(app, `${label}-student`);
    const order = await request(app.getHttpServer())
      .post(`/courses/${course.id}/course-orders`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ idempotencyKey: `${label}-idem-${Date.now()}` })
      .expect(201);
    return { owner, org, academy, course, student, order: order.body };
  }

  it('offers the academy’s enabled manual methods to the buyer of the order', async () => {
    const method = await seedPaymentMethod(admin, 'p64pm-offered');
    const { student, order } = await arrangeOrder('p64pm-happy');

    const res = await request(app.getHttpServer())
      .get(`/course-orders/${order.id}/payment-methods`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    // Atlas Payments mode may only ever offer the Atlas manual provider.
    for (const item of res.body) {
      expect(item.provider).toBe('atlas_manual');
      expect(item.enabled).toBe(true);
    }
    expect(res.body.map((m: { key: string }) => m.key)).toContain(method.key);
  });

  it('never offers a disabled method', async () => {
    const disabled = await seedPaymentMethod(admin, 'p64pm-disabled', { enabled: false });
    const { student, order } = await arrangeOrder('p64pm-dis');

    const res = await request(app.getHttpServer())
      .get(`/course-orders/${order.id}/payment-methods`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);

    expect(res.body.map((m: { key: string }) => m.key)).not.toContain(disabled.key);
  });

  it('returns an empty list — not an error — once the organization turns payment collection off under an open order', async () => {
    // An order can never be CREATED against an unconfigured
    // organization (that is refused at 409, see
    // `course-commerce.e2e-spec.ts`), so the only way to reach the
    // `unconfigured` branch with a real order is for the owner to turn
    // collection off while the order is still open. The learner must
    // then be told "nothing to pay with" honestly, not shown a method
    // `createPayment` would reject with `paymentSetupIncomplete`.
    await seedPaymentMethod(admin, 'p64pm-unconfigured');
    const { owner, org, student, order } = await arrangeOrder('p64pm-unconf');

    await request(app.getHttpServer())
      .patch(`/organizations/${org.id}/payment-settings`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ paymentCollectionMode: 'unconfigured' })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get(`/course-orders/${order.id}/payment-methods`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);

    expect(res.body).toEqual([]);
  });

  it('refuses another learner’s order with 404 — the order id alone is never authority', async () => {
    await seedPaymentMethod(admin, 'p64pm-foreign');
    const { order } = await arrangeOrder('p64pm-owner');
    const outsider = await signUpAndSignIn(app, 'p64pm-outsider');

    await request(app.getHttpServer())
      .get(`/course-orders/${order.id}/payment-methods`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .expect(404);
  });

  it('requires authentication', async () => {
    const { order } = await arrangeOrder('p64pm-anon');
    await request(app.getHttpServer())
      .get(`/course-orders/${order.id}/payment-methods`)
      .expect(401);
  });

  it('agrees with payment creation: every method it offers is accepted by POST :id/payments', async () => {
    await seedPaymentMethod(admin, 'p64pm-agree');
    const { student, order } = await arrangeOrder('p64pm-agree');

    const listed = await request(app.getHttpServer())
      .get(`/course-orders/${order.id}/payment-methods`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);
    expect(listed.body.length).toBeGreaterThan(0);

    // One order can only carry one active payment, so the agreement is
    // proven on the first offered method — the branch that decides the
    // list is the same one `createPayment` re-walks for any of them.
    const chosen = listed.body[0];
    const payment = await request(app.getHttpServer())
      .post(`/course-orders/${order.id}/payments`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ methodKey: chosen.key })
      .expect(201);
    expect(payment.body.methodKey).toBe(chosen.key);
  });
});
