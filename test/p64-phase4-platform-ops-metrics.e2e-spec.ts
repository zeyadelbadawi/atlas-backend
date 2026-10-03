/**
 * P64 Phase 4 §E.5 — `GET /platform-metrics/commerce` and
 * `GET /platform-metrics/delivery` (the Platform Owner's checkout /
 * approval / refund and access / retention counts). Proves, with
 * delta-based assertions so pre-existing rows in the shared dev database
 * never make it flaky: a real purchase → proof → approval / rejection /
 * refund flow moves the commerce counts and latency sample exactly as
 * expected; seeded `content_access_log` rows inside and outside the window
 * move grants and the retention backlog; the three-guard access rule (401
 * anonymous, 403 non-owner); the `days` bound; and that no PII leaks.
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

const DAY_MS = 24 * 60 * 60 * 1000;

describe('Platform ops metrics — commerce & delivery (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    // Same precondition `course-commerce.e2e-spec.ts` establishes: an
    // Atlas Payments purchase refuses to proceed without a global commission.
    await setGlobalCommission(1000);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  async function account(label: string) {
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
      email,
      auth: { Authorization: `Bearer ${signIn.body.accessToken as string}` },
    };
  }

  async function platformOwnerAccount(label: string) {
    const owner = await account(label);
    await admin.user.update({
      where: { id: owner.userId },
      data: { isPlatformOwner: true },
    });
    return owner;
  }

  async function setGlobalCommission(basisPoints: number): Promise<void> {
    const owner = await platformOwnerAccount(`pom-commission-${Date.now()}`);
    await request(app.getHttpServer())
      .patch('/platform-commission/global')
      .set(owner.auth)
      .send({ defaultCommissionBasisPoints: basisPoints })
      .expect(200);
  }

  /** A paid, published, public course under a fresh Organization in Atlas Payments mode, plus a manual-transfer method — the same fixture `course-commerce.e2e-spec.ts` builds. */
  async function arrangePaidCourse(label: string, priceAmountMinorUnits: number) {
    const owner = await account(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    const course = await seedCourse(admin, academy.id, `${label} Course ${Date.now()}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'paid',
      pricingAmountMinorUnits: BigInt(priceAmountMinorUnits),
      pricingCurrency: 'USD',
    });
    await request(app.getHttpServer())
      .patch(`/organizations/${org.id}/payment-settings`)
      .set(owner.auth)
      .send({ paymentCollectionMode: 'atlas_payments' })
      .expect(200);
    const method = await seedPaymentMethod(admin, `${label}-method`);
    return { owner, org, academy, course, method };
  }

  /** Student creates the order, the payment and uploads a proof — leaves the payment `pending` review. */
  async function orderWithProof(label: string, priceAmountMinorUnits: number) {
    const fixture = await arrangePaidCourse(label, priceAmountMinorUnits);
    const student = await account(`${label}-student`);
    const orderRes = await request(app.getHttpServer())
      .post(`/courses/${fixture.course.id}/course-orders`)
      .set(student.auth)
      .send({ idempotencyKey: `${label}-order-idem` })
      .expect(201);
    const paymentRes = await request(app.getHttpServer())
      .post(`/course-orders/${orderRes.body.id}/payments`)
      .set(student.auth)
      .send({ methodKey: fixture.method.key })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/course-orders/${orderRes.body.id}/payments/${paymentRes.body.id}/proof`)
      .set(student.auth)
      .send({ fileData: PROOF_DATA_URL, fileName: 'proof.png' })
      .expect(200);
    return {
      ...fixture,
      student,
      orderId: orderRes.body.id as string,
      paymentId: paymentRes.body.id as string,
    };
  }

  async function orderStatuses(orderIds: string[]): Promise<Record<string, number>> {
    const rows = await admin.courseOrder.findMany({
      where: { id: { in: orderIds } },
      select: { status: true },
    });
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
    return counts;
  }

  const ORDER_STATUS_KEY: Record<string, string> = {
    draft: 'draft',
    pending_payment: 'pendingPayment',
    paid: 'paid',
    expired: 'expired',
    refunded: 'refunded',
    cancelled: 'cancelled',
  };

  it('commerce: a real purchase → approval / rejection / refund flow moves every count and the latency sample', async () => {
    const reviewer = await platformOwnerAccount('pom-reviewer');

    const defaultWindow = await request(app.getHttpServer())
      .get('/platform-metrics/commerce')
      .set(reviewer.auth)
      .expect(200);
    expect(defaultWindow.body.windowDays).toBe(30);

    // `before` and `after` must read the SAME window: a delta between a
    // 30-day and a 7-day read goes negative as soon as the shared database
    // holds any order 7–30 days old (other suites seed backdated orders).
    const before = await request(app.getHttpServer())
      .get('/platform-metrics/commerce?days=7')
      .set(reviewer.auth)
      .expect(200);
    expect(before.body.windowDays).toBe(7);

    // A: approved and kept. B: approved, then refunded by the student.
    // C: rejected. D: proof uploaded, never reviewed (the backlog).
    const a = await orderWithProof('pom-a', 4900);
    const b = await orderWithProof('pom-b', 2500);
    const c = await orderWithProof('pom-c', 1100);
    const d = await orderWithProof('pom-d', 700);

    for (const p of [a, b]) {
      await request(app.getHttpServer())
        .post(`/platform-course-order-payments/${p.paymentId}/approve`)
        .set(reviewer.auth)
        .send({})
        .expect(201);
    }
    await request(app.getHttpServer())
      .post(`/platform-course-order-payments/${c.paymentId}/reject`)
      .set(reviewer.auth)
      .send({ notes: 'unreadable proof' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/course-orders/${b.orderId}/refund`)
      .set(b.student.auth)
      .send({ idempotencyKey: 'pom-b-refund', reason: 'Changed my mind' })
      .expect(201);

    const after = await request(app.getHttpServer())
      .get('/platform-metrics/commerce?days=7')
      .set(reviewer.auth)
      .expect(200);
    expect(after.body.windowDays).toBe(7);

    // Orders created in the window, by their CURRENT status — expected
    // buckets come from the real rows, never from a guess about what a
    // rejection does to an order.
    const statuses = await orderStatuses([a.orderId, b.orderId, c.orderId, d.orderId]);
    expect(Object.values(statuses).reduce((sum, n) => sum + n, 0)).toBe(4);
    expect(statuses.paid).toBe(1);
    expect(statuses.refunded).toBe(1);
    expect(after.body.orders.created - before.body.orders.created).toBe(4);
    for (const [status, key] of Object.entries(ORDER_STATUS_KEY)) {
      expect(after.body.orders[key] - before.body.orders[key]).toBe(
        statuses[status] ?? 0,
      );
    }
    // `created` is exactly the sum of its buckets.
    const bucketSum = Object.values(ORDER_STATUS_KEY).reduce(
      (sum, key) => sum + (after.body.orders[key] as number),
      0,
    );
    expect(bucketSum).toBe(after.body.orders.created);

    expect(after.body.payments.awaitingReview - before.body.payments.awaitingReview).toBe(
      1,
    );
    expect(
      after.body.payments.approvedInWindow - before.body.payments.approvedInWindow,
    ).toBe(2);
    expect(
      after.body.payments.rejectedInWindow - before.body.payments.rejectedInWindow,
    ).toBe(1);

    expect(
      after.body.approvalLatencySeconds.sampleSize -
        before.body.approvalLatencySeconds.sampleSize,
    ).toBe(2);
    expect(typeof after.body.approvalLatencySeconds.p50).toBe('number');
    expect(typeof after.body.approvalLatencySeconds.p95).toBe('number');
    expect(after.body.approvalLatencySeconds.p50).toBeGreaterThanOrEqual(0);
    expect(after.body.approvalLatencySeconds.p95).toBeGreaterThanOrEqual(
      after.body.approvalLatencySeconds.p50,
    );
    // Proof → approval took well under a minute here.
    expect(after.body.approvalLatencySeconds.p95).toBeLessThan(60);
    expect(after.body.approvalLatencySeconds.truncated).toBe(false);

    expect(
      after.body.refunds.requestedInWindow - before.body.refunds.requestedInWindow,
    ).toBe(1);
    expect(
      after.body.refunds.completedInWindow - before.body.refunds.completedInWindow,
    ).toBe(1);

    // Only A is still `paid`: B was refunded, so its snapshot price drops out.
    const usd = (body: typeof after.body) => body.revenue.paidByCurrency.USD ?? 0;
    expect(usd(after.body) - usd(before.body)).toBe(4900);

    // Counts only — never emails, names, or ids.
    const json = JSON.stringify(after.body);
    expect(json).not.toContain('@');
    expect(json.toLowerCase()).not.toContain('email');
    for (const id of [
      a.orderId,
      a.paymentId,
      a.course.id,
      a.academy.id,
      a.student.userId,
    ]) {
      expect(json).not.toContain(id);
    }
  });

  it('commerce: honours days=1 and reports null percentiles when the window holds no approvals', async () => {
    const owner = await platformOwnerAccount('pom-window');
    const res = await request(app.getHttpServer())
      .get('/platform-metrics/commerce?days=1')
      .set(owner.auth)
      .expect(200);
    expect(res.body.windowDays).toBe(1);
    const latency = res.body.approvalLatencySeconds;
    if (latency.sampleSize === 0) {
      expect(latency.p50).toBeNull();
      expect(latency.p95).toBeNull();
    } else {
      expect(typeof latency.p50).toBe('number');
    }
  });

  it('delivery: seeded access decisions inside the window move grants; rows past retention move the backlog only', async () => {
    const owner = await platformOwnerAccount('pom-delivery');

    const before = await request(app.getHttpServer())
      .get('/platform-metrics/delivery?days=30')
      .set(owner.auth)
      .expect(200);

    const tenant = await account('pom-delivery-tenant');
    const org = await seedOrganizationWithOwner(admin, tenant.userId, 'pom-delivery-org');
    const academy = await seedAcademy(admin, org.id, 'pom-delivery-academy');
    const course = await seedCourse(admin, academy.id, `pom-delivery ${Date.now()}`);
    const lessonId = `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, '0')}`;

    const seedDecision = (
      result: 'granted' | 'refused',
      reason: string | null,
      at: Date,
      userId?: string,
    ) =>
      admin.contentAccessLog.create({
        data: {
          academyId: academy.id,
          courseId: course.id,
          lessonId,
          result,
          reason,
          userId,
          deviceId: `dev-${Math.random().toString(36).slice(2)}`,
          createdAt: at,
        },
      });

    const now = new Date();
    // Inside the 30-day window: 3 grants, 2 deviceLimit refusals, 1 locked,
    // 1 refusal with no reason (→ `other`).
    await seedDecision('granted', 'video', now, tenant.userId);
    await seedDecision('granted', 'video', new Date(now.getTime() - 2 * DAY_MS));
    await seedDecision('granted', 'text', new Date(now.getTime() - 29 * DAY_MS));
    await seedDecision('refused', 'deviceLimit', now, tenant.userId);
    await seedDecision('refused', 'deviceLimit', new Date(now.getTime() - 1 * DAY_MS));
    await seedDecision('refused', 'locked', now);
    await seedDecision('refused', null, now);
    // Outside the 30-day window but inside 90-day retention: must not count anywhere.
    await seedDecision('refused', 'notEnrolled', new Date(now.getTime() - 45 * DAY_MS));
    // Past the 90-day retention window: the pending-prune backlog.
    await seedDecision('granted', 'video', new Date(now.getTime() - 100 * DAY_MS));
    await seedDecision(
      'refused',
      'sessionConflict',
      new Date(now.getTime() - 120 * DAY_MS),
    );

    const after = await request(app.getHttpServer())
      .get('/platform-metrics/delivery?days=30')
      .set(owner.auth)
      .expect(200);

    expect(after.body.windowDays).toBe(30);
    expect(after.body.grants.granted - before.body.grants.granted).toBe(3);
    expect(after.body.grants.refused - before.body.grants.refused).toBe(4);
    const reason = (body: typeof after.body, r: string) =>
      body.grants.refusedByReason[r] ?? 0;
    expect(reason(after.body, 'deviceLimit') - reason(before.body, 'deviceLimit')).toBe(
      2,
    );
    expect(reason(after.body, 'locked') - reason(before.body, 'locked')).toBe(1);
    expect(reason(after.body, 'other') - reason(before.body, 'other')).toBe(1);
    expect(reason(after.body, 'notEnrolled') - reason(before.body, 'notEnrolled')).toBe(
      0,
    );
    expect(
      reason(after.body, 'sessionConflict') - reason(before.body, 'sessionConflict'),
    ).toBe(0);
    expect(after.body.grants.truncated).toBe(false);

    expect(
      after.body.retention.contentAccessLogRowsPastWindow -
        before.body.retention.contentAccessLogRowsPastWindow,
    ).toBe(2);
    expect(typeof after.body.retention.quizAttemptEventsPastWindow).toBe('number');

    // `video` is the existing `/platform-metrics/video` shape, verbatim.
    const video = await request(app.getHttpServer())
      .get('/platform-metrics/video')
      .set(owner.auth)
      .expect(200);
    expect(Object.keys(after.body.video).sort()).toEqual(Object.keys(video.body).sort());
    expect(after.body.video.totalVideoAssets).toBe(video.body.totalVideoAssets);

    // A 60-day window picks up the 45-day-old refusal too, and nothing older.
    const wider = await request(app.getHttpServer())
      .get('/platform-metrics/delivery?days=60')
      .set(owner.auth)
      .expect(200);
    expect(wider.body.grants.refused - after.body.grants.refused).toBeGreaterThanOrEqual(
      1,
    );

    // Counts only — no user/device/session/course/academy ids, no emails.
    const json = JSON.stringify(after.body);
    expect(json).not.toContain('@');
    expect(json.toLowerCase()).not.toContain('email');
    for (const id of [tenant.userId, academy.id, course.id, lessonId]) {
      expect(json).not.toContain(id);
    }
    expect(json).not.toContain('dev-');
  });

  it('rejects an out-of-range `days` (0, 91, non-integer) with 400', async () => {
    const owner = await platformOwnerAccount('pom-days');
    for (const path of ['commerce', 'delivery']) {
      await request(app.getHttpServer())
        .get(`/platform-metrics/${path}?days=0`)
        .set(owner.auth)
        .expect(400);
      await request(app.getHttpServer())
        .get(`/platform-metrics/${path}?days=91`)
        .set(owner.auth)
        .expect(400);
      await request(app.getHttpServer())
        .get(`/platform-metrics/${path}?days=abc`)
        .set(owner.auth)
        .expect(400);
    }
  });

  it('refuses a non-platform-owner (403) and an anonymous caller (401) on both routes', async () => {
    const someone = await account('pom-nobody');
    for (const path of ['commerce', 'delivery']) {
      await request(app.getHttpServer())
        .get(`/platform-metrics/${path}`)
        .set(someone.auth)
        .expect(403);
      await request(app.getHttpServer()).get(`/platform-metrics/${path}`).expect(401);
    }
  });
});
