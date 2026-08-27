/**
 * Course Pricing, Purchase & Payouts — functional/contract e2e suite
 * (Phase P13, master plan §21/§23). The real business flow this phase
 * exists to prove end to end: a paid, published course → a student
 * creates a CourseOrder → creates a Payment (Atlas Payments mode, reusing
 * `ManualTransferProvider`) → uploads proof → a Platform Owner reviews
 * (approve/reject) → approval atomically creates the Enrollment and the
 * commission-split ledger entries → a Platform Owner computes/records an
 * Academy payout from the settled ledger → a student requests a full
 * refund within the 30-day window, which atomically reverses the
 * Enrollment and inserts the reversing ledger entries.
 *
 * Tenant isolation is covered separately in
 * `course-commerce-tenant-isolation.e2e-spec.ts`.
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

const PROOF_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

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

describe('Course Commerce — P13 (e2e)', () => {
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

  /** Seeds a paid, published, public course under a fresh Academy/Organization, and a fresh student — the common fixture every scenario below builds on. */
  async function arrangePaidCourse(
    label: string,
    priceAmountMinorUnits = 4900,
  ): Promise<{
    owner: { userId: string; accessToken: string };
    org: { id: string };
    academy: { id: string };
    course: { id: string; title: string };
    student: { userId: string; accessToken: string };
  }> {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    const course = await seedCourse(admin, academy.id, `${label} Course ${Date.now()}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'paid',
      pricingAmountMinorUnits: BigInt(priceAmountMinorUnits),
      pricingCurrency: 'USD',
    });
    const student = await signUpAndSignIn(app, `${label}-student`);
    return { owner, org, academy, course, student };
  }

  async function setAtlasPaymentsMode(orgId: string, accessToken: string): Promise<void> {
    await request(app.getHttpServer())
      .patch(`/organizations/${orgId}/payment-settings`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ paymentCollectionMode: 'atlas_payments' })
      .expect(200);
  }

  async function setGlobalCommission(basisPoints: number): Promise<void> {
    const owner = await signUpAndSignIn(app, `commission-admin-${Date.now()}`);
    await makePlatformOwner(admin, owner.userId);
    await request(app.getHttpServer())
      .patch('/platform-commission/global')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ defaultCommissionBasisPoints: basisPoints })
      .expect(200);
  }

  /** Full happy-path purchase, through Platform Owner approval — returns everything a later assertion/step might need. */
  async function purchaseCourseToApproval(label: string, priceAmountMinorUnits = 4900) {
    const fixture = await arrangePaidCourse(label, priceAmountMinorUnits);
    await setAtlasPaymentsMode(fixture.org.id, fixture.owner.accessToken);
    const method = await seedPaymentMethod(admin, `${label}-method`);

    const orderRes = await request(app.getHttpServer())
      .post(`/courses/${fixture.course.id}/course-orders`)
      .set('Authorization', `Bearer ${fixture.student.accessToken}`)
      .send({ idempotencyKey: `${label}-order-idem` })
      .expect(201);

    const paymentRes = await request(app.getHttpServer())
      .post(`/course-orders/${orderRes.body.id}/payments`)
      .set('Authorization', `Bearer ${fixture.student.accessToken}`)
      .send({ methodKey: method.key })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/course-orders/${orderRes.body.id}/payments/${paymentRes.body.id}/proof`)
      .set('Authorization', `Bearer ${fixture.student.accessToken}`)
      .send({ fileData: PROOF_DATA_URL, fileName: 'proof.png' })
      .expect(200);

    const platformOwner = await signUpAndSignIn(app, `${label}-reviewer`);
    await makePlatformOwner(admin, platformOwner.userId);

    const approveRes = await request(app.getHttpServer())
      .post(`/platform-course-order-payments/${paymentRes.body.id}/approve`)
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .send({})
      .expect(201);

    return { ...fixture, order: orderRes.body, payment: approveRes.body, platformOwner };
  }

  // --- 1. Course pricing is represented correctly -------------------------

  it('1: a paid course exposes real pricing on the public discovery response', async () => {
    const { course, student } = await arrangePaidCourse('pricing', 12345);
    const res = await request(app.getHttpServer())
      .get(`/courses/${course.id}`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);
    expect(res.body.pricing).toMatchObject({
      type: 'paid',
      amount: 123.45,
      currency: 'USD',
    });
  });

  // --- 2. Successful paid enrollment --------------------------------------

  it('2: full purchase flow atomically creates the Enrollment on Platform Owner approval', async () => {
    const { student, course, payment } = await purchaseCourseToApproval('happy-path');

    expect(payment.status).toBe('succeeded');

    const enrollmentRes = await request(app.getHttpServer())
      .get(`/enrollments/by-course/${course.id}`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);
    expect(enrollmentRes.body).toMatchObject({ status: 'enrolled' });
  });

  it('rejects enrollment via the free-enrollment endpoint for a paid course order — no double path to access', async () => {
    const { course, student } = await arrangePaidCourse('no-free-bypass');
    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ courseId: course.id })
      .expect(403);
  });

  it('refuses to create a CourseOrder for an unconfigured Organization — never a silent default', async () => {
    const { course, student } = await arrangePaidCourse('unconfigured-block');
    await request(app.getHttpServer())
      .post(`/courses/${course.id}/course-orders`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ idempotencyKey: 'unconfigured-idem' })
      .expect(409);
  });

  it('CourseOrder creation is idempotent on (student, idempotencyKey)', async () => {
    const { org, owner, course, student } = await arrangePaidCourse('order-idem');
    await setAtlasPaymentsMode(org.id, owner.accessToken);

    const first = await request(app.getHttpServer())
      .post(`/courses/${course.id}/course-orders`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ idempotencyKey: 'same-key' })
      .expect(201);
    const second = await request(app.getHttpServer())
      .post(`/courses/${course.id}/course-orders`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ idempotencyKey: 'same-key' })
      .expect(201);
    expect(second.body.id).toBe(first.body.id);
  });

  // --- 3. Payment failure ---------------------------------------------------

  it('3: Platform Owner rejection marks the Payment failed and never creates an Enrollment', async () => {
    const fixture = await arrangePaidCourse('reject-flow');
    await setAtlasPaymentsMode(fixture.org.id, fixture.owner.accessToken);
    const method = await seedPaymentMethod(admin, 'reject-flow-method');

    const orderRes = await request(app.getHttpServer())
      .post(`/courses/${fixture.course.id}/course-orders`)
      .set('Authorization', `Bearer ${fixture.student.accessToken}`)
      .send({ idempotencyKey: 'reject-order' })
      .expect(201);
    const paymentRes = await request(app.getHttpServer())
      .post(`/course-orders/${orderRes.body.id}/payments`)
      .set('Authorization', `Bearer ${fixture.student.accessToken}`)
      .send({ methodKey: method.key })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/course-orders/${orderRes.body.id}/payments/${paymentRes.body.id}/proof`)
      .set('Authorization', `Bearer ${fixture.student.accessToken}`)
      .send({ fileData: PROOF_DATA_URL, fileName: 'proof.png' })
      .expect(200);

    const reviewer = await signUpAndSignIn(app, 'reject-flow-reviewer');
    await makePlatformOwner(admin, reviewer.userId);
    const rejectRes = await request(app.getHttpServer())
      .post(`/platform-course-order-payments/${paymentRes.body.id}/reject`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ notes: 'Proof amount does not match the order.' })
      .expect(201);
    expect(rejectRes.body.status).toBe('failed');

    const enrollmentRes = await request(app.getHttpServer())
      .get(`/enrollments/by-course/${fixture.course.id}`)
      .set('Authorization', `Bearer ${fixture.student.accessToken}`)
      .expect(200);
    expect(enrollmentRes.body).toBeNull();
  });

  // --- 4. Duplicate review is impossible (payment-level idempotency) ------

  it('4: a second approval attempt on an already-approved Payment is rejected, never double-applied', async () => {
    const { payment } = await purchaseCourseToApproval('double-approve');

    const reviewer2 = await signUpAndSignIn(app, 'double-approve-reviewer-2');
    await makePlatformOwner(admin, reviewer2.userId);
    await request(app.getHttpServer())
      .post(`/platform-course-order-payments/${payment.id}/approve`)
      .set('Authorization', `Bearer ${reviewer2.accessToken}`)
      .send({})
      .expect(409);
  });

  // --- 5. Atlas Payments commission ----------------------------------------

  it('5/6: Atlas Payments mode snapshots and records commission on the Payment and the ledger; Organization-Owned Gateway never does', async () => {
    await setGlobalCommission(1000); // 10%
    const { payment, academy, course } = await purchaseCourseToApproval(
      'commission-atlas',
      10000,
    );

    expect(payment.paymentCollectionModeSnapshot).toBe('atlas_payments');
    expect(payment.commission).toMatchObject({
      rateBasisPoints: 1000,
      amountMinorUnits: 1000,
    });

    const summary = await admin.revenueLedgerEntry.findMany({
      where: { academyId: academy.id, courseOrder: { courseId: course.id } },
    });
    const sale = summary.find((e) => e.entryType === 'sale');
    const fee = summary.find((e) => e.entryType === 'platform_fee');
    expect(sale?.amountMinorUnits).toBe(10000n);
    expect(fee?.amountMinorUnits).toBe(-1000n);
  });

  it('6: Organization-Owned Gateway mode never resolves a commission — no real gateway is registered, so payment creation honestly fails rather than silently defaulting to Atlas Payments', async () => {
    const { org, owner, course, student } = await arrangePaidCourse('org-gateway');
    await request(app.getHttpServer())
      .patch(`/organizations/${org.id}/payment-settings`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ paymentCollectionMode: 'organization_gateway' })
      .expect(200);
    const method = await seedPaymentMethod(admin, 'org-gateway-method');

    await setGlobalCommission(1500);
    const orderRes = await request(app.getHttpServer())
      .post(`/courses/${course.id}/course-orders`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ idempotencyKey: 'org-gateway-order' })
      .expect(201);

    const paymentAttempt = await request(app.getHttpServer())
      .post(`/course-orders/${orderRes.body.id}/payments`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ methodKey: method.key })
      .expect(409);
    expect(paymentAttempt.body.error.messageKey).toBe(
      'errors.courseOrder.gatewayNotConfigured',
    );

    // Structurally impossible for Atlas to have created a commission
    // liability for this Organization — no Payment row (and therefore no
    // ledger entry) exists for this order at all.
    const payments = await admin.payment.findMany({
      where: { courseOrderId: orderRes.body.id },
    });
    expect(payments).toHaveLength(0);
  });

  // --- 7/8/9/10. Commission precedence: org override -> plan -> global default ---

  it('7/8/9/10: commission resolution precedence — organization override beats plan tier beats platform default', async () => {
    const platformOwner = await signUpAndSignIn(app, `precedence-admin-${Date.now()}`);
    await makePlatformOwner(admin, platformOwner.userId);

    // Global default: 20%
    await request(app.getHttpServer())
      .patch('/platform-commission/global')
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .send({ defaultCommissionBasisPoints: 2000 })
      .expect(200);

    const owner = await signUpAndSignIn(app, 'precedence-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'precedence-org');
    const academy = await seedAcademy(admin, org.id, 'precedence-academy');
    const plan = await admin.plan.create({
      data: {
        key: `precedence-plan-${Date.now()}`,
        name: 'Precedence Plan',
        limits: {
          academies: 1,
          students: 1,
          instructors: 1,
          staff: 1,
          courses: 1,
          generalStorage: 1,
          videoStorage: 1,
        },
        features: {
          cms: false,
          seo: false,
          seoAdvanced: false,
          marketing: false,
          marketingAdvanced: false,
          analytics: false,
          analyticsAdvanced: false,
          customDomain: false,
          themes: false,
          multipleThemes: false,
          backup: false,
        },
      },
    });
    await admin.tenantSubscription.create({
      data: { organizationId: org.id, planId: plan.id, status: 'active' },
    });

    // 8. Plan-tier: 12% — beats the 20% global default.
    await request(app.getHttpServer())
      .patch(`/platform-commission/plans/${plan.key}`)
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .send({ commissionBasisPoints: 1200 })
      .expect(200);

    const readAfterPlan = await request(app.getHttpServer())
      .get(`/organizations/${org.id}/payment-settings/commission`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(readAfterPlan.body.effective).toMatchObject({
      basisPoints: 1200,
      source: 'plan',
    });

    // 9/10. Organization-specific custom override: 5% — beats the 12% plan tier.
    await request(app.getHttpServer())
      .patch(`/platform-commission/organizations/${org.id}`)
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .send({ commissionMode: 'custom', customPercentageBasisPoints: 500 })
      .expect(200);

    const readAfterOverride = await request(app.getHttpServer())
      .get(`/organizations/${org.id}/payment-settings/commission`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(readAfterOverride.body.effective).toMatchObject({
      basisPoints: 500,
      source: 'custom',
    });

    // An Organization can never write its own override — Platform-Owner-only.
    await request(app.getHttpServer())
      .patch(`/platform-commission/organizations/${org.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ commissionMode: 'exempt' })
      .expect(403);

    void academy; // fixture retained for symmetry with other scenarios; not directly asserted here.
  });

  // --- 11. Commission snapshot immutability --------------------------------

  it('11: a Payment already created keeps its frozen commission snapshot even after the global default changes', async () => {
    await setGlobalCommission(1000);
    const { payment } = await purchaseCourseToApproval('snapshot-immutable', 5000);
    expect(payment.commission).toMatchObject({
      rateBasisPoints: 1000,
      amountMinorUnits: 500,
    });

    // Platform Owner changes the global default AFTER the Payment/approval.
    await setGlobalCommission(4000);

    const reReadOwner = await signUpAndSignIn(app, 'snapshot-reread');
    await makePlatformOwner(admin, reReadOwner.userId);
    const reRead = await request(app.getHttpServer())
      .get(`/platform-course-order-payments/${payment.id}`)
      .set('Authorization', `Bearer ${reReadOwner.accessToken}`)
      .expect(200);
    expect(reRead.body.commission).toMatchObject({
      rateBasisPoints: 1000,
      amountMinorUnits: 500,
    });
  });

  // --- 12. Payout calculation ------------------------------------------------

  it('12: Platform Owner payout computation settles exactly the unsettled sale minus commission, per Academy', async () => {
    await setGlobalCommission(1000); // 10%
    const { academy, platformOwner } = await purchaseCourseToApproval(
      'payout-calc',
      20000,
    );

    const start = new Date(Date.now() - 60_000).toISOString();
    const end = new Date(Date.now() + 60_000).toISOString();
    const payoutRes = await request(app.getHttpServer())
      .post('/platform-academy-payouts')
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .send({ academyId: academy.id, periodStart: start, periodEnd: end })
      .expect(201);

    expect(payoutRes.body).toHaveLength(1);
    expect(payoutRes.body[0]).toMatchObject({
      academyId: academy.id,
      status: 'pending',
      money: { amountMinorUnits: 18000, currency: 'USD' }, // 20000 - 2000 (10%)
    });

    // A second payout run over the same (now-settled) period finds nothing left.
    const secondRun = await request(app.getHttpServer())
      .post('/platform-academy-payouts')
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .send({ academyId: academy.id, periodStart: start, periodEnd: end })
      .expect(201);
    expect(secondRun.body).toHaveLength(0);

    const markPaid = await request(app.getHttpServer())
      .post(`/platform-academy-payouts/${payoutRes.body[0].id}/mark-paid`)
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .send({})
      .expect(201);
    expect(markPaid.body.status).toBe('paid');
  });

  // --- 13/16. Full refund within 30 days, enrollment reversal -------------

  it('13/16: a full refund within the window reverses the Enrollment and inserts reversing ledger entries', async () => {
    await setGlobalCommission(1000);
    const { student, course, order, academy } = await purchaseCourseToApproval(
      'refund-happy',
      8000,
    );

    const refundRes = await request(app.getHttpServer())
      .post(`/course-orders/${order.id}/refund`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ idempotencyKey: 'refund-1', reason: 'Changed my mind' })
      .expect(201);
    expect(refundRes.body).toMatchObject({
      status: 'succeeded',
      refundType: 'full', // structurally ready for a future 'partial' value — see schema.prisma
      money: { amountMinorUnits: 8000, currency: 'USD' },
    });

    const enrollmentRes = await request(app.getHttpServer())
      .get(`/enrollments/by-course/${course.id}`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);
    expect(enrollmentRes.body.status).toBe('unavailable');

    const ledger = await admin.revenueLedgerEntry.findMany({
      where: { academyId: academy.id, courseOrderId: order.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(ledger.map((e) => e.entryType)).toEqual([
      'sale',
      'platform_fee',
      'refund',
      'commission_reversal',
    ]);
    expect(ledger.find((e) => e.entryType === 'refund')?.amountMinorUnits).toBe(-8000n);
    expect(
      ledger.find((e) => e.entryType === 'commission_reversal')?.amountMinorUnits,
    ).toBe(800n);

    const orderRow = await admin.courseOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(orderRow.status).toBe('refunded');
  });

  // --- 14. Refund after 30 days rejected -----------------------------------

  it('14: a refund request after the 30-day window is rejected', async () => {
    const { student, order } = await purchaseCourseToApproval('refund-expired', 4000);

    await admin.courseOrder.update({
      where: { id: order.id },
      data: { paidAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
    });

    await request(app.getHttpServer())
      .post(`/course-orders/${order.id}/refund`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ idempotencyKey: 'refund-expired-1' })
      .expect(403);
  });

  // --- 15. Duplicate refund protection ---------------------------------------

  it('15: duplicate refund requests are impossible — a real database unique constraint, never just an application check', async () => {
    const { student, order } = await purchaseCourseToApproval('refund-duplicate', 3000);

    const first = await request(app.getHttpServer())
      .post(`/course-orders/${order.id}/refund`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ idempotencyKey: 'dup-1' })
      .expect(201);

    // Same idempotency key — idempotent replay, same refund record.
    const replay = await request(app.getHttpServer())
      .post(`/course-orders/${order.id}/refund`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ idempotencyKey: 'dup-1' })
      .expect(201);
    expect(replay.body.id).toBe(first.body.id);

    // A DIFFERENT idempotency key on an already-refunded order — still
    // resolves to the SAME existing refund, never a second one.
    const differentKey = await request(app.getHttpServer())
      .post(`/course-orders/${order.id}/refund`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ idempotencyKey: 'dup-2' })
      .expect(201);
    expect(differentKey.body.id).toBe(first.body.id);

    const refunds = await admin.courseOrderRefund.findMany({
      where: { courseOrderId: order.id },
    });
    expect(refunds).toHaveLength(1);

    const ledgerRefundEntries = await admin.revenueLedgerEntry.findMany({
      where: { courseOrderId: order.id, entryType: 'refund' },
    });
    expect(ledgerRefundEntries).toHaveLength(1);
  });

  it('a refund request for an order that was never paid is rejected', async () => {
    const { org, owner, course, student } = await arrangePaidCourse('refund-unpaid');
    await setAtlasPaymentsMode(org.id, owner.accessToken);
    const orderRes = await request(app.getHttpServer())
      .post(`/courses/${course.id}/course-orders`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ idempotencyKey: 'unpaid-order' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/course-orders/${orderRes.body.id}/refund`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ idempotencyKey: 'unpaid-refund' })
      .expect(409);
  });

  // --- 19. Authorization ------------------------------------------------------

  it('19: requires authentication and the platform_owner role on every review/payout route', async () => {
    const nonOwner = await signUpAndSignIn(app, 'authz-non-owner');

    await request(app.getHttpServer()).get('/course-orders').expect(401);
    await request(app.getHttpServer()).get('/platform-course-order-payments').expect(401);
    await request(app.getHttpServer())
      .get('/platform-course-order-payments')
      .set('Authorization', `Bearer ${nonOwner.accessToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .post('/platform-academy-payouts')
      .set('Authorization', `Bearer ${nonOwner.accessToken}`)
      .send({
        academyId: 'x',
        periodStart: new Date().toISOString(),
        periodEnd: new Date().toISOString(),
      })
      .expect(403);
  });

  it('a reviewer who is a member of the selling Organization cannot approve/reject its own course-order payments (self-review guard)', async () => {
    const fixture = await arrangePaidCourse('self-review');
    await setAtlasPaymentsMode(fixture.org.id, fixture.owner.accessToken);
    const method = await seedPaymentMethod(admin, 'self-review-method');

    const orderRes = await request(app.getHttpServer())
      .post(`/courses/${fixture.course.id}/course-orders`)
      .set('Authorization', `Bearer ${fixture.student.accessToken}`)
      .send({ idempotencyKey: 'self-review-order' })
      .expect(201);
    const paymentRes = await request(app.getHttpServer())
      .post(`/course-orders/${orderRes.body.id}/payments`)
      .set('Authorization', `Bearer ${fixture.student.accessToken}`)
      .send({ methodKey: method.key })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/course-orders/${orderRes.body.id}/payments/${paymentRes.body.id}/proof`)
      .set('Authorization', `Bearer ${fixture.student.accessToken}`)
      .send({ fileData: PROOF_DATA_URL, fileName: 'proof.png' })
      .expect(200);

    await makePlatformOwner(admin, fixture.owner.userId);
    await request(app.getHttpServer())
      .post(`/platform-course-order-payments/${paymentRes.body.id}/approve`)
      .set('Authorization', `Bearer ${fixture.owner.accessToken}`)
      .send({})
      .expect(403);
  });

  // --- 20. Financial transaction atomicity (state-consistency proof) ------

  it('20: after approval, Payment/CourseOrder/Enrollment/ledger state is fully consistent — never a partial result', async () => {
    const { payment, order, course, student, academy } = await purchaseCourseToApproval(
      'atomicity',
      6000,
    );

    const paymentRow = await admin.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    const orderRow = await admin.courseOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    const enrollmentRow = await admin.enrollment.findUniqueOrThrow({
      where: { studentId_courseId: { studentId: student.userId, courseId: course.id } },
    });
    const ledgerRows = await admin.revenueLedgerEntry.findMany({
      where: { academyId: academy.id, courseOrderId: order.id },
    });

    expect(paymentRow.status).toBe('succeeded');
    expect(orderRow.status).toBe('paid');
    expect(orderRow.paidAt).not.toBeNull();
    expect(enrollmentRow.status).toBe('enrolled');
    expect(ledgerRows.length).toBeGreaterThanOrEqual(1);
  });
});
