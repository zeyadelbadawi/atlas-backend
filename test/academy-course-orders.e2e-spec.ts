/**
 * Academy Orders (Task 4) — `GET academies/:id/course-orders[/:orderId]`
 * for the Organization Owner, and the Platform Owner's payment review
 * lists' real filters, search, sort and review context.
 *
 * Pinned here:
 *   - only the Organization Owner reads an academy's orders; a manager, an
 *     instructor and another organization's owner are refused, and an
 *     order of a sibling academy or another organization is a 404 even by
 *     direct id;
 *   - the payload never carries the order's idempotency key, payment
 *     instructions, proofs, the commission snapshot or the student's full
 *     email/id;
 *   - every filter, the whitelisted sorts and pagination (with the page
 *     size cap) behave server-side;
 *   - the new RLS read policies are SELECT-only and organization-scoped;
 *   - the Platform lists honour status/method/date filters, sort and search,
 *     name the organization/academy, course and plan, and drop the
 *     manual-transfer instructions and proof notes from list rows while the
 *     detail keeps them.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedCourse,
  seedMembership,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';

const SECRET_ACCOUNT_NUMBER = '9876501234';
const SECRET_STORAGE_KEY_PREFIX = 'payment-proofs/secret-';
const SECRET_PROOF_NOTE = 'proof note that must stay private';

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

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Keys that must never appear anywhere in an academy-facing payload. */
const FORBIDDEN_KEYS = [
  'idempotencyKey',
  'instructions',
  'instructionsSnapshot',
  'manualInstructions',
  'proof',
  'proofs',
  'storageKey',
  'commission',
  'commissionAmountMinorUnits',
  'commissionRateBasisPointsSnapshot',
  'studentId',
  'payerUserId',
  'reviewNotes',
  'reviewedBy',
  'email',
];

function collectKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((v) => collectKeys(v, into));
  } else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      into.add(key);
      collectKeys(v, into);
    }
  }
  return into;
}

describe('Academy course orders (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  let owner: { userId: string; accessToken: string };
  let otherOwner: { userId: string; accessToken: string };
  let orgId: string;
  let otherOrgId: string;
  let academyId: string;
  let siblingAcademyId: string;
  let courseAlgebraId: string;
  let courseBiologyId: string;
  let studentSaraEmail: string;
  let o1: string; // paid, 5000, refunded-succeeded, Sara, Algebra, 2026-09-01
  let o2: string; // pending_payment, 9000, rejected then pending (InstaPay), Omar, Biology, 2026-09-10
  let o3: string; // expired, 1000, no payment, Sara, Biology, 2026-09-20
  let siblingOrder: string;
  let otherOrgOrder: string;
  const idempotencyKeys: string[] = [];
  const marker = unique('acorders');

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    await flushRateLimitKeys();

    owner = await signUpAndSignIn(app, 'acorders-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'acorders-org');
    orgId = org.id;
    const academy = await seedAcademy(admin, orgId, `${marker}-academy`);
    academyId = academy.id;
    const sibling = await seedAcademy(admin, orgId, `${marker}-sibling`);
    siblingAcademyId = sibling.id;

    otherOwner = await signUpAndSignIn(app, 'acorders-other-owner');
    const otherOrg = await seedOrganizationWithOwner(
      admin,
      otherOwner.userId,
      'acorders-other-org',
    );
    otherOrgId = otherOrg.id;
    const otherAcademy = await seedAcademy(admin, otherOrgId, `${marker}-other-academy`);

    const paid = {
      status: 'published' as const,
      visibility: 'public' as const,
      pricingType: 'paid' as const,
      pricingAmountMinorUnits: 5000n,
      pricingCurrency: 'USD',
    };
    const algebra = await seedCourse(admin, academyId, `Alpha Algebra ${marker}`, paid);
    courseAlgebraId = algebra.id;
    const biology = await seedCourse(admin, academyId, `Beta Biology ${marker}`, paid);
    courseBiologyId = biology.id;
    const siblingCourse = await seedCourse(
      admin,
      siblingAcademyId,
      `Sibling ${marker}`,
      paid,
    );
    const otherCourse = await seedCourse(admin, otherAcademy.id, `Other ${marker}`, paid);

    studentSaraEmail = `sara-${marker}@example.test`;
    const sara = await admin.user.create({
      data: { email: studentSaraEmail, name: `Sara ${marker}` },
    });
    const omar = await admin.user.create({
      data: { email: `omar-${marker}@example.test`, name: `Omar ${marker}` },
    });

    async function order(
      studentId: string,
      course: { id: string; title: string; academyId: string },
      organizationId: string,
      status: 'paid' | 'pending_payment' | 'expired',
      amount: number,
      createdAt: string,
    ) {
      const idempotencyKey = unique('secret-idem');
      idempotencyKeys.push(idempotencyKey);
      return admin.courseOrder.create({
        data: {
          studentId,
          courseId: course.id,
          academyId: course.academyId,
          organizationId,
          snapshot: {
            course: { id: course.id, title: course.title },
            price: { amountMinorUnits: amount, currency: 'USD' },
            capturedAt: createdAt,
          },
          status,
          expiresAt: new Date(new Date(createdAt).getTime() + 3600_000),
          idempotencyKey,
          createdAt: new Date(createdAt),
          paidAt: status === 'paid' ? new Date(createdAt) : null,
        },
      });
    }

    async function payment(
      courseOrder: { id: string; studentId: string; academyId: string },
      over: {
        status: 'succeeded' | 'pending' | 'failed';
        reviewStatus: 'approved' | 'pending' | 'rejected';
        methodType: 'manual_bank_transfer' | 'manual_instapay';
        amount: number;
        createdAt: string;
        providerReference?: string;
      },
    ) {
      const created = await admin.payment.create({
        data: {
          payerUserId: courseOrder.studentId,
          payeeAcademyId: courseOrder.academyId,
          courseOrderId: courseOrder.id,
          methodKey: `${over.methodType}-${marker}`,
          methodType: over.methodType,
          provider: 'atlas_manual',
          amountMinorUnits: BigInt(over.amount),
          currency: 'USD',
          status: over.status,
          reviewStatus: over.reviewStatus,
          reviewNotes: 'reviewer-only note',
          providerReference: over.providerReference,
          instructionsSnapshot: {
            type: 'manual_bank_transfer',
            bankName: 'Secret Bank',
            accountName: 'Atlas',
            accountNumber: SECRET_ACCOUNT_NUMBER,
          },
          commissionRateBasisPointsSnapshot: 1000,
          commissionAmountMinorUnits: BigInt(Math.round(over.amount / 10)),
          paymentCollectionModeSnapshot: 'atlas_payments',
          createdAt: new Date(over.createdAt),
        },
      });
      await admin.paymentProof.create({
        data: {
          paymentId: created.id,
          fileName: 'receipt.png',
          storageKey: `${SECRET_STORAGE_KEY_PREFIX}${created.id}`,
          mimeType: 'image/png',
          note: SECRET_PROOF_NOTE,
        },
      });
      return created;
    }

    const algebraRef = { id: algebra.id, title: algebra.title, academyId };
    const biologyRef = { id: biology.id, title: biology.title, academyId };

    const order1 = await order(
      sara.id,
      algebraRef,
      orgId,
      'paid',
      5000,
      '2026-09-01T10:00:00.000Z',
    );
    const p1 = await payment(order1, {
      status: 'succeeded',
      reviewStatus: 'approved',
      methodType: 'manual_bank_transfer',
      amount: 5000,
      createdAt: '2026-09-01T10:05:00.000Z',
      providerReference: `REF-${marker}`,
    });
    await admin.courseOrderRefund.create({
      data: {
        courseOrderId: order1.id,
        paymentId: p1.id,
        status: 'succeeded',
        amountMinorUnits: 5000n,
        currency: 'USD',
        reason: 'student private reason',
        requestedBy: sara.id,
        idempotencyKey: unique('secret-refund-idem'),
        processedAt: new Date('2026-09-03T10:00:00.000Z'),
      },
    });
    o1 = order1.id;

    const order2 = await order(
      omar.id,
      biologyRef,
      orgId,
      'pending_payment',
      9000,
      '2026-09-10T10:00:00.000Z',
    );
    await payment(order2, {
      status: 'failed',
      reviewStatus: 'rejected',
      methodType: 'manual_bank_transfer',
      amount: 9000,
      createdAt: '2026-09-10T10:05:00.000Z',
    });
    await payment(order2, {
      status: 'pending',
      reviewStatus: 'pending',
      methodType: 'manual_instapay',
      amount: 9000,
      createdAt: '2026-09-11T10:05:00.000Z',
    });
    o2 = order2.id;

    const order3 = await order(
      sara.id,
      biologyRef,
      orgId,
      'expired',
      1000,
      '2026-09-20T10:00:00.000Z',
    );
    o3 = order3.id;

    const sOrder = await order(
      omar.id,
      { id: siblingCourse.id, title: siblingCourse.title, academyId: siblingAcademyId },
      orgId,
      'paid',
      7000,
      '2026-09-05T10:00:00.000Z',
    );
    siblingOrder = sOrder.id;

    const xOrder = await order(
      omar.id,
      { id: otherCourse.id, title: otherCourse.title, academyId: otherAcademy.id },
      otherOrgId,
      'paid',
      7000,
      '2026-09-05T10:00:00.000Z',
    );
    otherOrgOrder = xOrder.id;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  const list = (query: Record<string, string | number>, token = owner.accessToken) =>
    request(app.getHttpServer())
      .get(`/academies/${academyId}/course-orders`)
      .query(query)
      .set('Authorization', `Bearer ${token}`);

  const ids = (body: { items: { id: string }[] }) => body.items.map((i) => i.id);

  describe('access', () => {
    it('the Organization Owner sees exactly this academy’s orders, newest first', async () => {
      const res = await list({}).expect(200);
      expect(ids(res.body)).toEqual([o3, o2, o1]);
      expect(res.body.pagination).toMatchObject({ page: 1, totalItems: 3 });
      expect(ids(res.body)).not.toContain(siblingOrder);
      expect(ids(res.body)).not.toContain(otherOrgOrder);
    });

    it('a manager and an instructor of the academy are refused (list and detail)', async () => {
      const instructor = await signUpAndSignIn(app, 'acorders-instructor');
      await seedMembership(admin, orgId, instructor.userId, 'instructor');
      await seedAcademyMember(admin, academyId, instructor.userId, 'instructor');
      const manager = await signUpAndSignIn(app, 'acorders-manager');
      await seedMembership(admin, orgId, manager.userId, 'manager');
      await seedAcademyMember(admin, academyId, manager.userId, 'manager');

      for (const caller of [instructor, manager]) {
        await list({}, caller.accessToken).expect(403);
        await request(app.getHttpServer())
          .get(`/academies/${academyId}/course-orders/${o1}`)
          .set('Authorization', `Bearer ${caller.accessToken}`)
          .expect(403);
      }
    });

    it('another organization’s owner is refused', async () => {
      await list({}, otherOwner.accessToken).expect(403);
      await request(app.getHttpServer())
        .get(`/academies/${academyId}/course-orders/${o1}`)
        .set('Authorization', `Bearer ${otherOwner.accessToken}`)
        .expect(403);
    });

    it('a sibling academy’s or another organization’s order is a 404 by direct id', async () => {
      for (const orderId of [siblingOrder, otherOrgOrder, 'does-not-exist']) {
        await request(app.getHttpServer())
          .get(`/academies/${academyId}/course-orders/${orderId}`)
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .expect(404);
      }
    });

    it('an unauthenticated caller is refused', async () => {
      await request(app.getHttpServer())
        .get(`/academies/${academyId}/course-orders`)
        .expect(401);
    });
  });

  describe('payload', () => {
    it('list rows carry the summary and none of the sensitive fields', async () => {
      const res = await list({}).expect(200);
      const keys = collectKeys(res.body);
      for (const key of FORBIDDEN_KEYS) expect(keys.has(key)).toBe(false);

      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(SECRET_ACCOUNT_NUMBER);
      expect(raw).not.toContain(SECRET_STORAGE_KEY_PREFIX);
      expect(raw).not.toContain(SECRET_PROOF_NOTE);
      expect(raw).not.toContain(studentSaraEmail);
      expect(raw).not.toContain('student private reason');
      expect(raw).not.toContain('reviewer-only note');
      for (const key of idempotencyKeys) expect(raw).not.toContain(key);

      const first = res.body.items.find((i: { id: string }) => i.id === o1);
      expect(first).toMatchObject({
        id: o1,
        status: 'paid',
        money: { amountMinorUnits: 5000, currency: 'USD' },
        course: { id: courseAlgebraId, title: `Alpha Algebra ${marker}` },
        student: { name: `Sara ${marker}` },
        latestPayment: {
          status: 'succeeded',
          reviewStatus: 'approved',
          methodType: 'manual_bank_transfer',
          providerReference: `REF-${marker}`,
        },
        paymentCount: 1,
        refund: { status: 'succeeded' },
      });
      expect(first.student.maskedEmail).toMatch(/^s•••@example\.test$/);
      expect(first.paidAt).toBe('2026-09-01T10:00:00.000Z');
    });

    it('the detail lists every payment attempt newest first, with the same redaction', async () => {
      const res = await request(app.getHttpServer())
        .get(`/academies/${academyId}/course-orders/${o2}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(res.body.payments).toHaveLength(2);
      expect(
        res.body.payments.map((p: { reviewStatus: string }) => p.reviewStatus),
      ).toEqual(['pending', 'rejected']);
      expect(res.body.latestPayment.methodType).toBe('manual_instapay');
      expect(res.body.paymentCount).toBe(2);
      expect(res.body.refund).toBeUndefined();

      const keys = collectKeys(res.body);
      for (const key of FORBIDDEN_KEYS) expect(keys.has(key)).toBe(false);
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(SECRET_ACCOUNT_NUMBER);
      expect(raw).not.toContain(SECRET_STORAGE_KEY_PREFIX);
    });
  });

  describe('filters', () => {
    it.each<[Record<string, string>, () => string[]]>([
      [{ status: 'paid' }, () => [o1]],
      [{ status: 'expired' }, () => [o3]],
      [{ paymentStatus: 'failed' }, () => [o2]],
      [{ reviewStatus: 'rejected' }, () => [o2]],
      [{ reviewStatus: 'approved' }, () => [o1]],
      [{ methodType: 'manual_instapay' }, () => [o2]],
      [{ refundStatus: 'succeeded' }, () => [o1]],
      [{ refundStatus: 'none' }, () => [o3, o2]],
      [{ from: '2026-09-05', to: '2026-09-15' }, () => [o2]],
      [{ from: '2026-09-10' }, () => [o3, o2]],
      [{ to: '2026-09-01' }, () => [o1]],
    ])('%j', async (query, expected) => {
      const res = await list(query).expect(200);
      expect(ids(res.body)).toEqual(expected());
      expect(res.body.pagination.totalItems).toBe(expected().length);
    });

    it('filters by course', async () => {
      const res = await list({ courseId: courseBiologyId }).expect(200);
      expect(ids(res.body)).toEqual([o3, o2]);
    });

    it('two payment conditions must hold for the same payment', async () => {
      // o2 has a rejected bank transfer and a pending InstaPay — never a
      // rejected InstaPay.
      const res = await list({
        reviewStatus: 'rejected',
        methodType: 'manual_instapay',
      }).expect(200);
      expect(ids(res.body)).toEqual([]);
    });

    it('searches by student name, student email, course title and order id', async () => {
      expect(ids((await list({ search: `sara ${marker}` }).expect(200)).body)).toEqual([
        o3,
        o1,
      ]);
      expect(ids((await list({ search: `omar-${marker}@` }).expect(200)).body)).toEqual([
        o2,
      ]);
      expect(ids((await list({ search: 'beta biology' }).expect(200)).body)).toEqual([
        o3,
        o2,
      ]);
      expect(ids((await list({ search: o1 }).expect(200)).body)).toEqual([o1]);
      expect(ids((await list({ search: 'no-such-thing-xyz' }).expect(200)).body)).toEqual(
        [],
      );
    });

    it('refuses unknown filter values and undeclared parameters', async () => {
      await list({ status: 'stolen' }).expect(400);
      await list({ refundStatus: 'maybe' }).expect(400);
      await list({ from: '09/01/2026' }).expect(400);
      await list({ organizationId: otherOrgId }).expect(400);
    });
  });

  describe('sort and pagination', () => {
    it('sorts by amount in both directions', async () => {
      expect(
        ids((await list({ sortBy: 'amount', sortDirection: 'asc' }).expect(200)).body),
      ).toEqual([o3, o1, o2]);
      expect(
        ids((await list({ sortBy: 'amount', sortDirection: 'desc' }).expect(200)).body),
      ).toEqual([o2, o1, o3]);
    });

    it('sorts by paid date with unpaid orders last, and by creation date', async () => {
      const paidFirst = ids(
        (await list({ sortBy: 'paidAt', sortDirection: 'desc' }).expect(200)).body,
      );
      expect(paidFirst[0]).toBe(o1);
      expect(
        ids((await list({ sortBy: 'createdAt', sortDirection: 'asc' }).expect(200)).body),
      ).toEqual([o1, o2, o3]);
    });

    it('refuses a sort field outside the allow-list', async () => {
      await list({ sortBy: 'idempotencyKey' }).expect(400);
      await list({ sortBy: 'organizationId' }).expect(400);
    });

    it('pages server-side, including under the amount sort', async () => {
      const page2 = await list({ pageSize: 2, page: 2 }).expect(200);
      expect(ids(page2.body)).toEqual([o1]);
      expect(page2.body.pagination).toMatchObject({
        page: 2,
        pageSize: 2,
        totalItems: 3,
        totalPages: 2,
      });
      const amountPage2 = await list({
        pageSize: 2,
        page: 2,
        sortBy: 'amount',
        sortDirection: 'asc',
      }).expect(200);
      expect(ids(amountPage2.body)).toEqual([o2]);
      expect(amountPage2.body.pagination.totalItems).toBe(3);
    });

    it('caps the page size', async () => {
      await list({ pageSize: 100 }).expect(200);
      await list({ pageSize: 101 }).expect(400);
      await list({ pageSize: 100000 }).expect(400);
      await list({ pageSize: 0 }).expect(400);
    });
  });

  describe('RLS (SELECT-only, organization-scoped)', () => {
    it('another organization’s tenant context sees none of these rows; the owning one sees them', async () => {
      const tenancy = app.get(TenancyContextService);
      const foreign = await tenancy.runInTenantContext(otherOrgId, async (tx) => ({
        orders: await tx.courseOrder.count({ where: { academyId } }),
        payments: await tx.payment.count({ where: { payeeAcademyId: academyId } }),
        refunds: await tx.courseOrderRefund.count({ where: { courseOrderId: o1 } }),
      }));
      expect(foreign).toEqual({ orders: 0, payments: 0, refunds: 0 });

      const own = await tenancy.runInTenantContext(orgId, async (tx) => ({
        orders: await tx.courseOrder.count({ where: { academyId } }),
        payments: await tx.payment.count({ where: { payeeAcademyId: academyId } }),
        refunds: await tx.courseOrderRefund.count({ where: { courseOrderId: o1 } }),
      }));
      expect(own).toEqual({ orders: 3, payments: 3, refunds: 1 });
    });

    it('the owning organization’s tenant context still cannot change an order or payment', async () => {
      const tenancy = app.get(TenancyContextService);
      const changed = await tenancy.runInTenantContext(orgId, async (tx) => ({
        orders: (
          await tx.courseOrder.updateMany({ where: { id: o2 }, data: { status: 'paid' } })
        ).count,
        payments: (
          await tx.payment.updateMany({
            where: { courseOrderId: o2 },
            data: { reviewStatus: 'approved' },
          })
        ).count,
      }));
      expect(changed).toEqual({ orders: 0, payments: 0 });
      const stillPending = await admin.courseOrder.findUniqueOrThrow({
        where: { id: o2 },
      });
      expect(stillPending.status).toBe('pending_payment');
    });
  });

  describe('Platform payment review lists', () => {
    let reviewer: { userId: string; accessToken: string };
    let subscriptionPaymentIds: string[];
    const orgName = `${marker}-payer-org`;

    beforeAll(async () => {
      reviewer = await signUpAndSignIn(app, 'acorders-reviewer');
      await admin.user.update({
        where: { id: reviewer.userId },
        data: { isPlatformOwner: true },
      });
      await admin.organization.update({ where: { id: orgId }, data: { name: orgName } });

      subscriptionPaymentIds = [];
      const rows: [
        number,
        'pending' | 'succeeded',
        'pending' | 'approved',
        string,
        string,
      ][] = [
        [30000, 'pending', 'pending', 'manual_bank_transfer', '2026-09-02T10:00:00.000Z'],
        [10000, 'succeeded', 'approved', 'manual_instapay', '2026-09-12T10:00:00.000Z'],
        [20000, 'pending', 'pending', 'manual_instapay', '2026-09-22T10:00:00.000Z'],
      ];
      for (const [amount, status, reviewStatus, methodType, createdAt] of rows) {
        const checkout = await admin.checkout.create({
          data: {
            organizationId: orgId,
            targetType: 'plan_subscription',
            targetKey: `pro-${marker}`,
            billingCycle: 'yearly',
            snapshot: {
              target: { type: 'plan_subscription', planKey: `pro-${marker}` },
              billingCycle: 'yearly',
              displayName: `Pro ${marker}`,
              price: { amountMinorUnits: amount, currency: 'EGP' },
              capturedAt: createdAt,
            },
            status: 'pending_payment',
            expiresAt: new Date('2027-01-01T00:00:00.000Z'),
            idempotencyKey: unique('checkout'),
          },
        });
        const p = await admin.payment.create({
          data: {
            checkoutId: checkout.id,
            organizationId: orgId,
            methodKey: `${methodType}-${marker}`,
            methodType: methodType as 'manual_bank_transfer' | 'manual_instapay',
            provider: 'atlas_manual',
            amountMinorUnits: BigInt(amount),
            currency: 'EGP',
            status,
            reviewStatus,
            providerReference: `SUBREF-${marker}-${amount}`,
            instructionsSnapshot: {
              type: 'manual_bank_transfer',
              bankName: 'Secret Bank',
              accountName: 'Atlas',
              accountNumber: SECRET_ACCOUNT_NUMBER,
            },
            createdAt: new Date(createdAt),
          },
        });
        await admin.paymentProof.create({
          data: {
            paymentId: p.id,
            fileName: 'receipt.png',
            storageKey: `${SECRET_STORAGE_KEY_PREFIX}${p.id}`,
            mimeType: 'image/png',
            note: SECRET_PROOF_NOTE,
          },
        });
        subscriptionPaymentIds.push(p.id);
      }
    });

    const platformList = (path: string, query: Record<string, string | number>) =>
      request(app.getHttpServer())
        .get(path)
        .query(query)
        .set('Authorization', `Bearer ${reviewer.accessToken}`);

    it('subscription list: searches by organization name and names the organization and plan', async () => {
      const res = await platformList('/payments', {
        search: orgName,
        pageSize: 100,
      }).expect(200);
      const [a, b, c] = subscriptionPaymentIds;
      expect(ids(res.body)).toEqual([c, b, a]);
      const item = res.body.items[0];
      expect(item.organization).toEqual({ id: orgId, name: orgName });
      expect(item.checkoutSummary).toEqual({
        targetType: 'plan_subscription',
        targetKey: `pro-${marker}`,
        displayName: `Pro ${marker}`,
        billingCycle: 'yearly',
      });
    });

    it('subscription list rows drop instructions and proof notes; the detail keeps instructions', async () => {
      const res = await platformList('/payments', {
        search: orgName,
        pageSize: 100,
      }).expect(200);
      const raw = JSON.stringify(res.body);
      expect(collectKeys(res.body).has('instructions')).toBe(false);
      expect(raw).not.toContain(SECRET_ACCOUNT_NUMBER);
      expect(raw).not.toContain(SECRET_PROOF_NOTE);
      expect(raw).not.toContain(SECRET_STORAGE_KEY_PREFIX);
      expect(res.body.items[0].proof.fileName).toBe('receipt.png');

      const detail = await platformList(
        `/payments/${subscriptionPaymentIds[0]}`,
        {},
      ).expect(200);
      expect(detail.body.instructions.accountNumber).toBe(SECRET_ACCOUNT_NUMBER);
      expect(detail.body.organization.name).toBe(orgName);
      expect(detail.body.checkoutSummary.billingCycle).toBe('yearly');
    });

    it('subscription list: status, method, review and date filters, sort, and provider-reference search', async () => {
      const [a, b, c] = subscriptionPaymentIds;
      const q = (extra: Record<string, string>) =>
        platformList('/payments', { search: orgName, pageSize: 100, ...extra }).expect(
          200,
        );
      expect(ids((await q({ status: 'succeeded' })).body)).toEqual([b]);
      expect(ids((await q({ methodType: 'manual_instapay' })).body)).toEqual([c, b]);
      expect(ids((await q({ reviewStatus: 'pending' })).body)).toEqual([c, a]);
      expect(ids((await q({ from: '2026-09-10', to: '2026-09-20' })).body)).toEqual([b]);
      expect(ids((await q({ sortBy: 'amount', sortDirection: 'asc' })).body)).toEqual([
        b,
        c,
        a,
      ]);
      expect(ids((await q({ sortBy: 'createdAt', sortDirection: 'asc' })).body)).toEqual([
        a,
        b,
        c,
      ]);

      const byRef = await platformList('/payments', {
        search: `SUBREF-${marker}-20000`,
      }).expect(200);
      expect(ids(byRef.body)).toEqual([c]);
      const byId = await platformList('/payments', { search: a }).expect(200);
      expect(ids(byId.body)).toEqual([a]);
    });

    it('platform lists refuse unknown sort fields and oversized pages', async () => {
      await platformList('/payments', { sortBy: 'organizationId' }).expect(400);
      await platformList('/payments', { pageSize: 101 }).expect(400);
      await platformList('/platform-course-order-payments', {
        sortBy: 'commission',
      }).expect(400);
      await platformList('/platform-course-order-payments', { status: 'stolen' }).expect(
        400,
      );
    });

    it('course list: searches by academy name and names the academy, course, order and refund status', async () => {
      const res = await platformList('/platform-course-order-payments', {
        search: `${marker}-academy`,
        pageSize: 100,
      }).expect(200);
      expect(res.body.items).toHaveLength(3);
      const forO1 = res.body.items.find(
        (i: { courseOrderId: string }) => i.courseOrderId === o1,
      );
      expect(forO1).toMatchObject({
        academy: { id: academyId, name: `${marker}-academy` },
        course: { id: courseAlgebraId, title: `Alpha Algebra ${marker}` },
        courseOrderStatus: 'paid',
        refundStatus: 'succeeded',
      });
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(SECRET_PROOF_NOTE);
      expect(collectKeys(res.body).has('instructions')).toBe(false);
    });

    it('course list: course-title search, filters and amount sort', async () => {
      const q = (extra: Record<string, string>) =>
        platformList('/platform-course-order-payments', {
          search: `${marker}-academy`,
          pageSize: 100,
          ...extra,
        }).expect(200);
      const statuses = (body: {
        items: { reviewStatus: string; courseOrderId: string }[];
      }) => body.items.map((i) => `${i.courseOrderId}:${i.reviewStatus}`);

      expect(statuses((await q({ reviewStatus: 'rejected' })).body)).toEqual([
        `${o2}:rejected`,
      ]);
      expect(statuses((await q({ methodType: 'manual_instapay' })).body)).toEqual([
        `${o2}:pending`,
      ]);
      expect(statuses((await q({ status: 'succeeded' })).body)).toEqual([
        `${o1}:approved`,
      ]);
      expect(statuses((await q({ from: '2026-09-11', to: '2026-09-11' })).body)).toEqual([
        `${o2}:pending`,
      ]);
      const asc = (await q({ sortBy: 'amount', sortDirection: 'asc' })).body.items.map(
        (i: { money: { amountMinorUnits: number } }) => i.money.amountMinorUnits,
      );
      expect(asc).toEqual([5000, 9000, 9000]);

      const byTitle = await platformList('/platform-course-order-payments', {
        search: `Beta Biology ${marker}`,
        pageSize: 100,
      }).expect(200);
      expect(byTitle.body.items).toHaveLength(2);
    });

    it('course detail carries the review context and keeps the proof note', async () => {
      const listRes = await platformList('/platform-course-order-payments', {
        search: `REF-${marker}`,
      }).expect(200);
      expect(listRes.body.items).toHaveLength(1);
      const detail = await platformList(
        `/platform-course-order-payments/${listRes.body.items[0].id}`,
        {},
      ).expect(200);
      expect(detail.body.academy.name).toBe(`${marker}-academy`);
      expect(detail.body.refundStatus).toBe('succeeded');
      expect(detail.body.proof.note).toBe(SECRET_PROOF_NOTE);
    });
  });
});
