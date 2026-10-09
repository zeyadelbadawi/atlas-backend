/**
 * Bank Transfer for Atlas subscriptions, end to end (2 Oct 2026).
 *
 * Production could not offer Bank Transfer: the payment catalog had no
 * write path and only the development seed (sample bank details, never for
 * production) ever filled it. Pinned here against the real database:
 *   - the Platform Owner configures a bank-transfer method (validated,
 *     audited, only Platform Owners), and only enabled methods are offered;
 *   - an Organization Owner pays a MONTHLY or a YEARLY plan: the amount
 *     comes from the catalog (a yearly price only where the Platform Owner
 *     set one), the payment keeps the instructions it was shown, a receipt
 *     upload is validated and audited, and status is trackable;
 *   - the Platform Owner approves (subscription active, correct cycle and
 *     period end, the plan's limits) or rejects with a note;
 *   - a repeated payment request, a repeated approval and two concurrent
 *     approvals each take effect exactly once;
 *   - a failure inside the approval rolls everything back;
 *   - outsiders, other tenants, non-Platform-Owners and a Platform Owner
 *     reviewing their own Organization are refused, and receipts stay
 *     private.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma, seedOrganizationWithOwner } from './utils/db-admin';
import type { Plan, PrismaClient } from '@prisma/client';
import { PaymentApplicationService } from '../src/billing/services/payment-application.service';

const PROOF_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const NOT_AN_IMAGE = `data:image/png;base64,${Buffer.from('%PDF? no, plain text').toString('base64')}`;

const INSTRUCTIONS = {
  bankName: 'Test Bank (e2e)',
  accountName: 'Atlas Test Account',
  accountNumber: '0001 2345 6789',
  iban: 'GB33 BUKB 2020 1555 5555 55',
  instructions: 'Transfer the exact amount shown, then upload your receipt.',
  referenceInstructions: 'Use your organization name as the transfer reference.',
};

const DAY = 24 * 60 * 60 * 1000;

describe('Bank Transfer (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let platform: { email: string; userId: string; token: string };

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    platform = await account('bt-platform-owner');
    await admin.user.update({
      where: { id: platform.userId },
      data: { isPlatformOwner: true },
    });
    // The token carries the role: sign in again now that it is set.
    platform = await signIn(platform.email);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (url: string) => http().get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body: object = {}) =>
      http().post(url).set('Authorization', `Bearer ${token}`).send(body),
    patch: (url: string, body: object) =>
      http().patch(url).set('Authorization', `Bearer ${token}`).send(body),
  });

  async function signIn(email: string) {
    const response = await http()
      .post('/auth/sign-in')
      .send({ email, password: 'correct-horse-battery' })
      .expect(200);
    return {
      email,
      userId: response.body.user.id as string,
      token: response.body.accessToken as string,
    };
  }

  async function account(label: string) {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .send({ name: label, email, password: 'correct-horse-battery' })
      .expect(201);
    return signIn(email);
  }

  async function seedPlan(label: string, yearlyAmount?: number): Promise<Plan> {
    const key = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return admin.plan.create({
      data: {
        key,
        name: label,
        limits: {
          academies: 3,
          students: 150,
          instructors: 7,
          staff: 7,
          courses: 40,
          generalStorage: 15,
          videoStorage: 15,
        },
        features: { liveSessions: false },
        pricing: {
          amount: 79,
          currency: 'USD',
          billingCycle: 'monthly',
          ...(yearlyAmount !== undefined ? { yearlyAmount } : {}),
        },
      },
    });
  }

  async function configuredMethod(label: string) {
    const created = await as(platform.token)
      .post('/platform-payment-methods/bank-transfer', {
        displayName: `Bank transfer ${label}`,
        instructions: INSTRUCTIONS,
        enabled: true,
      })
      .expect(201);
    return created.body as { id: string; key: string };
  }

  async function organizationWithPlan(label: string) {
    const owner = await account(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    return { owner, org };
  }

  function checkout(
    token: string,
    orgId: string,
    planKey: string,
    billingCycle: 'monthly' | 'yearly',
    label: string,
  ) {
    return as(token).post(`/organizations/${orgId}/checkouts`, {
      target: { type: 'plan_subscription', planKey },
      billingCycle,
      idempotencyKey: `${label}-${Math.random().toString(36).slice(2)}`,
    });
  }

  async function payWithProof(
    label: string,
    cycle: 'monthly' | 'yearly',
    yearly?: number,
  ) {
    const { owner, org } = await organizationWithPlan(label);
    const plan = await seedPlan(`${label}-plan`, yearly);
    const method = await configuredMethod(label);
    const co = await checkout(owner.token, org.id, plan.key, cycle, label).expect(201);
    const payment = await as(owner.token)
      .post(`/organizations/${org.id}/payments`, {
        checkoutId: co.body.id,
        methodKey: method.key,
      })
      .expect(201);
    await as(owner.token)
      .patch(`/organizations/${org.id}/payments/${payment.body.id}/proof`, {
        fileData: PROOF_DATA_URL,
        fileName: 'receipt.png',
        mimeType: 'image/png',
      })
      .expect(200);
    return { owner, org, plan, method, checkout: co.body, payment: payment.body };
  }

  describe('Platform Owner configuration', () => {
    it('only a Platform Owner can configure methods; details are validated and audited', async () => {
      const outsider = await account('bt-config-outsider');
      await http().get('/platform-payment-methods').expect(401);
      await as(outsider.token).get('/platform-payment-methods').expect(403);
      await as(outsider.token)
        .post('/platform-payment-methods/bank-transfer', {
          displayName: 'x',
          instructions: INSTRUCTIONS,
        })
        .expect(403);

      // Invalid details are refused, not stored.
      const missing = { ...INSTRUCTIONS } as Record<string, string>;
      delete missing.bankName;
      for (const instructions of [
        missing,
        { ...INSTRUCTIONS, iban: 'not-an-iban' },
        { ...INSTRUCTIONS, accountNumber: '   ' },
        { ...INSTRUCTIONS, accountNumber: '12<script>' },
      ]) {
        await as(platform.token)
          .post('/platform-payment-methods/bank-transfer', {
            displayName: 'Bank transfer',
            instructions,
          })
          .expect(400);
      }
      // The client cannot choose the provider, type or capabilities.
      await as(platform.token)
        .post('/platform-payment-methods/bank-transfer', {
          displayName: 'Bank transfer',
          instructions: INSTRUCTIONS,
          provider: 'something-else',
        })
        .expect(400);

      // Created disabled by default: not offered to anyone yet.
      const created = await as(platform.token)
        .post('/platform-payment-methods/bank-transfer', {
          displayName: 'Bank transfer (config test)',
          instructions: INSTRUCTIONS,
        })
        .expect(201);
      expect(created.body).toMatchObject({
        type: 'manual_bank_transfer',
        provider: 'atlas_manual',
        enabled: false,
        capabilities: { supportsProof: true, supportsManualReview: true },
        manualInstructions: {
          type: 'manual_bank_transfer',
          bankName: 'Test Bank (e2e)',
          iban: 'GB33BUKB20201555555555',
        },
      });
      const owner = await account('bt-config-owner');
      // Every enabled method, across all pages (this database holds many
      // fixture methods).
      const offered = async () => {
        const keys: string[] = [];
        for (let page = 1; ; page += 1) {
          const res = await as(owner.token)
            .get(`/payment-methods?pageSize=100&page=${page}`)
            .expect(200);
          keys.push(...res.body.items.map((m: { key: string }) => m.key));
          if (page >= res.body.pagination.totalPages) return keys;
        }
      };
      expect(await offered()).not.toContain(created.body.key);

      await as(platform.token)
        .patch(`/platform-payment-methods/${created.body.id}`, { enabled: true })
        .expect(200);
      expect(await offered()).toContain(created.body.key);

      const audit = await admin.auditLogEntry.findMany({
        where: { targetId: created.body.id },
        orderBy: { occurredAt: 'asc' },
      });
      expect(audit.map((row) => row.action)).toEqual([
        'payment_method.created',
        'payment_method.updated',
      ]);
      // The audit trail never copies the account details.
      expect(JSON.stringify(audit)).not.toContain('0001 2345 6789');
    });
  });

  describe('Organization Owner pays, Platform Owner reviews', () => {
    it('monthly: catalog price, instructions kept with the payment, receipt validated, approval activates the plan', async () => {
      const { owner, org } = await organizationWithPlan('bt-monthly');
      const plan = await seedPlan('bt-monthly-plan', 790);
      const method = await configuredMethod('bt-monthly');

      // The client cannot send a price.
      await as(owner.token)
        .post(`/organizations/${org.id}/checkouts`, {
          target: { type: 'plan_subscription', planKey: plan.key },
          billingCycle: 'monthly',
          idempotencyKey: 'bt-monthly-price',
          price: { amountMinorUnits: 1, currency: 'USD' },
        })
        .expect(400);
      const co = await checkout(
        owner.token,
        org.id,
        plan.key,
        'monthly',
        'bt-monthly',
      ).expect(201);
      expect(co.body.snapshot).toMatchObject({
        billingCycle: 'monthly',
        price: { amountMinorUnits: 7900, currency: 'USD' },
      });

      const create = () =>
        as(owner.token).post(`/organizations/${org.id}/payments`, {
          checkoutId: co.body.id,
          methodKey: method.key,
        });
      const payment = await create().expect(201);
      expect(payment.body.instructions).toMatchObject({
        bankName: 'Test Bank (e2e)',
        accountNumber: '0001 2345 6789',
      });
      // A repeated request is the same payment, not a second one.
      const again = await create().expect(201);
      expect(again.body.id).toBe(payment.body.id);
      expect(await admin.payment.count({ where: { checkoutId: co.body.id } })).toBe(1);

      // Receipts: a file that is not an allowed image/PDF is refused.
      await as(owner.token)
        .patch(`/organizations/${org.id}/payments/${payment.body.id}/proof`, {
          fileData: NOT_AN_IMAGE,
          fileName: 'receipt.png',
          mimeType: 'image/png',
        })
        .expect(400);
      const proof = await as(owner.token)
        .patch(`/organizations/${org.id}/payments/${payment.body.id}/proof`, {
          fileData: PROOF_DATA_URL,
          fileName: 'receipt.png',
          mimeType: 'image/png',
        })
        .expect(200);
      expect(proof.body.reviewStatus).toBe('pending');
      expect(
        await admin.auditLogEntry.count({
          where: { targetId: payment.body.id, action: 'payment.proof_submitted' },
        }),
      ).toBe(1);

      // The owner tracks it.
      const tracked = await as(owner.token)
        .get(`/organizations/${org.id}/payments/${payment.body.id}`)
        .expect(200);
      expect(tracked.body.reviewStatus).toBe('pending');

      // Editing or disabling the method later does not change what this
      // payer was asked to do.
      await as(platform.token)
        .patch(`/platform-payment-methods/${method.id}`, {
          instructions: { ...INSTRUCTIONS, accountNumber: '9999 0000' },
          enabled: false,
        })
        .expect(200);
      const kept = await as(owner.token)
        .get(`/organizations/${org.id}/payments/${payment.body.id}`)
        .expect(200);
      expect(kept.body.instructions.accountNumber).toBe('0001 2345 6789');

      const before = Date.now();
      await as(platform.token)
        .post(`/payments/${payment.body.id}/approve`, { notes: 'Received in full.' })
        .expect(201);
      const subscription = await admin.tenantSubscription.findUniqueOrThrow({
        where: { organizationId: org.id },
      });
      expect(subscription).toMatchObject({
        status: 'active',
        planId: plan.id,
        billingCycle: 'monthly',
      });
      const end = subscription.currentPeriodEnd!.getTime();
      expect(end).toBeGreaterThan(before + 27 * DAY);
      expect(end).toBeLessThan(before + 32 * DAY);
      expect(subscription.grantedLimits).toMatchObject({ academies: 3, students: 150 });

      // Approving again changes nothing.
      await as(platform.token)
        .post(`/payments/${payment.body.id}/approve`, {})
        .expect(409);
      expect(
        await admin.paymentReview.count({ where: { paymentId: payment.body.id } }),
      ).toBe(1);
    });

    it('yearly: charged the yearly catalog price and given a year; no yearly price means no yearly checkout', async () => {
      const {
        org,
        owner,
        payment,
        checkout: co,
      } = await payWithProof('bt-yearly', 'yearly', 790);
      expect(co.snapshot).toMatchObject({
        billingCycle: 'yearly',
        price: { amountMinorUnits: 79000, currency: 'USD' },
      });
      const before = Date.now();
      await as(platform.token).post(`/payments/${payment.id}/approve`, {}).expect(201);
      const subscription = await admin.tenantSubscription.findUniqueOrThrow({
        where: { organizationId: org.id },
      });
      expect(subscription.billingCycle).toBe('yearly');
      const end = subscription.currentPeriodEnd!.getTime();
      expect(end).toBeGreaterThan(before + 360 * DAY);
      expect(end).toBeLessThan(before + 370 * DAY);

      const noYearly = await seedPlan('bt-no-yearly-plan');
      const refused = await checkout(
        owner.token,
        org.id,
        noYearly.key,
        'yearly',
        'bt-ny',
      ).expect(400);
      expect(refused.body.error.messageKey).toBe('errors.checkout.pricingUnavailable');
    });

    it('rejection needs a note, records it, and activates nothing', async () => {
      const { org, owner, payment } = await payWithProof('bt-reject', 'monthly');
      await as(platform.token)
        .post(`/payments/${payment.id}/reject`, { notes: 'short' })
        .expect(400);
      await as(platform.token)
        .post(`/payments/${payment.id}/reject`, {
          notes: 'The transfer reference does not match any receipt.',
        })
        .expect(201);
      const tracked = await as(owner.token)
        .get(`/organizations/${org.id}/payments/${payment.id}`)
        .expect(200);
      expect(tracked.body).toMatchObject({
        reviewStatus: 'rejected',
        reviewNotes: 'The transfer reference does not match any receipt.',
      });
      const subscription = await admin.tenantSubscription.findUnique({
        where: { organizationId: org.id },
      });
      expect(subscription?.status).not.toBe('active');
      await as(platform.token).post(`/payments/${payment.id}/approve`, {}).expect(409);
    });

    it('two approvals at the same moment take effect once', async () => {
      const { org, payment } = await payWithProof('bt-race', 'monthly');
      const before = Date.now();
      const results = await Promise.all([
        as(platform.token).post(`/payments/${payment.id}/approve`, {}),
        as(platform.token).post(`/payments/${payment.id}/approve`, {}),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await admin.paymentReview.count({ where: { paymentId: payment.id } })).toBe(
        1,
      );
      const subscription = await admin.tenantSubscription.findUniqueOrThrow({
        where: { organizationId: org.id },
      });
      // One month, not two.
      expect(subscription.currentPeriodEnd!.getTime()).toBeLessThan(before + 32 * DAY);
    });

    it('a failure inside the approval rolls everything back', async () => {
      const { org, payment } = await payWithProof('bt-interrupted', 'monthly');
      const application = app.get(PaymentApplicationService, { strict: false });
      const spy = jest
        .spyOn(application, 'applySuccessfulPayment')
        .mockRejectedValueOnce(new Error('simulated failure while activating'));
      try {
        await as(platform.token).post(`/payments/${payment.id}/approve`, {}).expect(500);
      } finally {
        spy.mockRestore();
      }
      const row = await admin.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(row.reviewStatus).toBe('pending');
      expect(await admin.paymentReview.count({ where: { paymentId: payment.id } })).toBe(
        0,
      );
      expect(
        await admin.auditLogEntry.count({
          where: { targetId: payment.id, action: 'payment.approved' },
        }),
      ).toBe(0);
      const subscription = await admin.tenantSubscription.findUnique({
        where: { organizationId: org.id },
      });
      expect(subscription?.status).not.toBe('active');

      // The same approval then succeeds, once.
      await as(platform.token).post(`/payments/${payment.id}/approve`, {}).expect(201);
      expect(await admin.paymentReview.count({ where: { paymentId: payment.id } })).toBe(
        1,
      );
    });
  });

  describe('access', () => {
    it('another tenant, a non-Platform-Owner and a self-reviewing Platform Owner are refused; receipts stay private', async () => {
      const { org, owner, payment } = await payWithProof('bt-access', 'monthly');
      const other = await organizationWithPlan('bt-access-other');

      await as(other.owner.token)
        .get(`/organizations/${org.id}/payments/${payment.id}`)
        .expect((res) => expect([403, 404]).toContain(res.status));
      await as(other.owner.token)
        .get(`/organizations/${org.id}/payments/${payment.id}/proof/file`)
        .expect((res) => expect([403, 404]).toContain(res.status));
      await as(other.owner.token)
        .get(`/organizations/${other.org.id}/payments/${payment.id}`)
        .expect(404);
      await http()
        .get(`/organizations/${org.id}/payments/${payment.id}/proof/file`)
        .expect(401);

      // Only a Platform Owner reviews, and never their own Organization.
      await as(owner.token).post(`/payments/${payment.id}/approve`, {}).expect(403);
      await as(owner.token).get('/payments').expect(403);
      const reviewerOwner = await account('bt-self-review');
      await admin.user.update({
        where: { id: reviewerOwner.userId },
        data: { isPlatformOwner: true },
      });
      const selfReviewer = await signIn(reviewerOwner.email);
      await admin.organizationMembership.create({
        data: { organizationId: org.id, userId: selfReviewer.userId, role: 'manager' },
      });
      const refused = await as(selfReviewer.token)
        .post(`/payments/${payment.id}/approve`, {})
        .expect(403);
      expect(refused.body.error.messageKey).toBe(
        'errors.payment.cannotReviewOwnOrganization',
      );

      // The receipt itself is served only through the authenticated route.
      const file = await as(owner.token)
        .get(`/organizations/${org.id}/payments/${payment.id}/proof/file`)
        .expect(200);
      expect(file.headers['content-type']).toContain('image/png');
      const proof = await admin.paymentProof.findFirstOrThrow({
        where: { paymentId: payment.id },
      });
      expect(proof.storageKey).not.toMatch(/^https?:/);
    });
  });
});
