/**
 * Atlas Subscription Billing — functional/contract e2e suite (P12, master
 * plan §21). The real business flow this phase exists to prove end to
 * end: Organization selects a Plan → creates a Checkout → submits a
 * manual bank/wallet Payment → uploads proof → a Platform Owner reviews
 * (approve/reject) → approval correctly updates `tenant_subscriptions`.
 *
 * Idempotency (`createCheckout` replay) and webhook signature/idempotency
 * are covered here too — the exact §18 scenario 8 requirement, applied to
 * Atlas billing first (master plan §21 P12's own "Tests" line).
 */
import { INestApplication } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedOrganizationWithOwner,
  seedPaymentMethod,
} from './utils/db-admin';
import type { Plan, PrismaClient } from '@prisma/client';

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

async function seedPricedPlan(
  admin: PrismaClient,
  keyLabel: string,
  amount = 79,
): Promise<Plan> {
  const key = `${keyLabel}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return admin.plan.create({
    data: {
      key,
      name: keyLabel,
      limits: {
        academies: 5,
        students: 200,
        instructors: 10,
        staff: 10,
        courses: 50,
        generalStorage: 20,
        videoStorage: 20,
      },
      features: {
        cms: true,
        seo: true,
        seoAdvanced: false,
        marketing: false,
        marketingAdvanced: false,
        analytics: false,
        analyticsAdvanced: false,
        customDomain: false,
        themes: true,
        multipleThemes: false,
        backup: false,
      },
      pricing: { amount, currency: 'USD', billingCycle: 'monthly' },
    },
  });
}

describe('Atlas Subscription Billing (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let webhookSecret: string;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    webhookSecret = process.env.PAYMENT_WEBHOOK_SECRET!;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  function signWebhookEvent(event: {
    id: string;
    type: string;
    paymentId: string;
    occurredAt: string;
  }): string {
    const canonical = `${event.id}.${event.type}.${event.paymentId}.${event.occurredAt}`;
    return createHmac('sha256', webhookSecret).update(canonical).digest('hex');
  }

  async function arrangeCheckoutAndPayment(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const plan = await seedPricedPlan(admin, `${label}-plan`, 79);
    await admin.tenantSubscription.create({
      data: { organizationId: org.id, planId: plan.id, status: 'trialing' },
    });
    const method = await seedPaymentMethod(admin, `${label}-method`);

    const checkoutRes = await request(app.getHttpServer())
      .post(`/organizations/${org.id}/checkouts`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        target: { type: 'plan_subscription', planKey: plan.key },
        billingCycle: 'monthly',
        idempotencyKey: `${label}-idem`,
      })
      .expect(201);

    const paymentRes = await request(app.getHttpServer())
      .post(`/organizations/${org.id}/payments`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ checkoutId: checkoutRes.body.id, methodKey: method.key })
      .expect(201);

    return { owner, org, plan, checkout: checkoutRes.body, payment: paymentRes.body };
  }

  async function submitProof(
    orgId: string,
    paymentId: string,
    accessToken: string,
  ): Promise<void> {
    await request(app.getHttpServer())
      .patch(`/organizations/${orgId}/payments/${paymentId}/proof`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fileData: PROOF_DATA_URL, fileName: 'proof.png', mimeType: 'image/png' })
      .expect(200);
  }

  describe('authorization', () => {
    it('requires authentication and organization membership on checkout/payment routes', async () => {
      const outsider = await signUpAndSignIn(app, 'billing-outsider');
      const owner = await signUpAndSignIn(app, 'billing-guarded-owner');
      const org = await seedOrganizationWithOwner(
        admin,
        owner.userId,
        'billing-guarded-org',
      );

      await request(app.getHttpServer())
        .post(`/organizations/${org.id}/checkouts`)
        .send({
          target: { type: 'plan_subscription', planKey: 'x' },
          idempotencyKey: 'k',
        })
        .expect(401);
      await request(app.getHttpServer())
        .post(`/organizations/${org.id}/checkouts`)
        .set('Authorization', `Bearer ${outsider.accessToken}`)
        .send({
          target: { type: 'plan_subscription', planKey: 'x' },
          idempotencyKey: 'k',
        })
        .expect(403);
    });

    it('requires the platform_owner role on the flat /payments review surface', async () => {
      const nonOwner = await signUpAndSignIn(app, 'billing-non-platform-owner');
      await request(app.getHttpServer()).get('/payments').expect(401);
      await request(app.getHttpServer())
        .get('/payments')
        .set('Authorization', `Bearer ${nonOwner.accessToken}`)
        .expect(403);
    });
  });

  describe('checkout creation and idempotency', () => {
    it('creates a Checkout with a real frozen snapshot computed from the catalog', async () => {
      const owner = await signUpAndSignIn(app, 'checkout-owner');
      const org = await seedOrganizationWithOwner(admin, owner.userId, 'checkout-org');
      const plan = await seedPricedPlan(admin, 'checkout-plan', 79);

      const response = await request(app.getHttpServer())
        .post(`/organizations/${org.id}/checkouts`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          target: { type: 'plan_subscription', planKey: plan.key },
          billingCycle: 'monthly',
          idempotencyKey: `checkout-idem-${Date.now()}`,
        })
        .expect(201);

      expect(response.body).toMatchObject({
        organizationId: org.id,
        target: { type: 'plan_subscription', planKey: plan.key },
        status: 'draft',
        snapshot: {
          displayName: plan.name,
          price: { amountMinorUnits: 7900, currency: 'USD' },
        },
      });
    });

    it('rejects a checkout against a plan with no configured pricing (never fabricates a price)', async () => {
      const owner = await signUpAndSignIn(app, 'checkout-nopricing-owner');
      const org = await seedOrganizationWithOwner(
        admin,
        owner.userId,
        'checkout-nopricing-org',
      );
      const plan = await admin.plan.create({
        data: {
          key: `no-pricing-${Date.now()}`,
          name: 'No Pricing',
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

      await request(app.getHttpServer())
        .post(`/organizations/${org.id}/checkouts`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          target: { type: 'plan_subscription', planKey: plan.key },
          idempotencyKey: `no-pricing-${Date.now()}`,
        })
        .expect(400);
    });

    it('replaying the same idempotencyKey never creates a second Checkout', async () => {
      const owner = await signUpAndSignIn(app, 'idem-owner');
      const org = await seedOrganizationWithOwner(admin, owner.userId, 'idem-org');
      const plan = await seedPricedPlan(admin, 'idem-plan');
      const idempotencyKey = `idem-key-${Date.now()}`;

      const first = await request(app.getHttpServer())
        .post(`/organizations/${org.id}/checkouts`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          target: { type: 'plan_subscription', planKey: plan.key },
          idempotencyKey,
        })
        .expect(201);

      const [second, third] = await Promise.all([
        request(app.getHttpServer())
          .post(`/organizations/${org.id}/checkouts`)
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send({
            target: { type: 'plan_subscription', planKey: plan.key },
            idempotencyKey,
          })
          .expect(201),
        request(app.getHttpServer())
          .post(`/organizations/${org.id}/checkouts`)
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send({
            target: { type: 'plan_subscription', planKey: plan.key },
            idempotencyKey,
          })
          .expect(201),
      ]);

      expect(second.body.id).toBe(first.body.id);
      expect(third.body.id).toBe(first.body.id);

      const rows = await admin.checkout.findMany({
        where: { organizationId: org.id, idempotencyKey },
      });
      expect(rows).toHaveLength(1);
    });
  });

  describe('the full manual-payment lifecycle', () => {
    it('createPayment moves the Checkout to pending_payment and the Payment starts pending/awaiting-proof', async () => {
      const { org, checkout, payment } =
        await arrangeCheckoutAndPayment('lifecycle-happy');

      expect(payment).toMatchObject({
        organizationId: org.id,
        checkoutId: checkout.id,
        status: 'pending',
        reviewStatus: 'not_required',
        nextAction: { type: 'awaiting_proof' },
      });

      const checkoutRow = await admin.checkout.findUniqueOrThrow({
        where: { id: checkout.id },
      });
      expect(checkoutRow.status).toBe('pending_payment');
    });

    it('submitProof moves reviewStatus to pending and never implies success by itself', async () => {
      const { owner, org, payment } = await arrangeCheckoutAndPayment('lifecycle-proof');

      const response = await request(app.getHttpServer())
        .patch(`/organizations/${org.id}/payments/${payment.id}/proof`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          fileData: PROOF_DATA_URL,
          fileName: 'proof.png',
          mimeType: 'image/png',
          note: 'ref',
        })
        .expect(200);

      expect(response.body.status).toBe('pending');
      expect(response.body.reviewStatus).toBe('pending');
      expect(response.body.proof).toMatchObject({ fileName: 'proof.png' });

      // Downloadable only by an authorized member of the owning organization.
      const download = await request(app.getHttpServer())
        .get(`/organizations/${org.id}/payments/${payment.id}/proof/file`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(download.headers['content-type']).toBe('image/png');

      const outsider = await signUpAndSignIn(app, 'lifecycle-proof-outsider');
      await request(app.getHttpServer())
        .get(`/organizations/${org.id}/payments/${payment.id}/proof/file`)
        .set('Authorization', `Bearer ${outsider.accessToken}`)
        .expect(403);
    });

    it('rejects an unsupported proof file type from its real decoded bytes, never the claimed mimeType', async () => {
      const { owner, org, payment } =
        await arrangeCheckoutAndPayment('lifecycle-badtype');
      const bogusDataUrl = `data:image/png;base64,${Buffer.from('not a real image').toString('base64')}`;

      await request(app.getHttpServer())
        .patch(`/organizations/${org.id}/payments/${payment.id}/proof`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ fileData: bogusDataUrl, fileName: 'x.png', mimeType: 'image/png' })
        .expect(400);
    });

    it('approve() correctly updates tenant_subscriptions and completes the Checkout', async () => {
      const { owner, org, plan, checkout, payment } =
        await arrangeCheckoutAndPayment('lifecycle-approve');

      const reviewer = await signUpAndSignIn(app, 'lifecycle-approve-reviewer');
      await makePlatformOwner(admin, reviewer.userId);

      // Cannot approve before proof exists (reviewStatus is still 'not_required').
      await request(app.getHttpServer())
        .post(`/payments/${payment.id}/approve`)
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .send({})
        .expect(409);

      await submitProof(org.id, payment.id, owner.accessToken);

      const approveRes = await request(app.getHttpServer())
        .post(`/payments/${payment.id}/approve`)
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .send({ notes: 'looks good' })
        .expect(201);

      expect(approveRes.body).toMatchObject({
        status: 'succeeded',
        reviewStatus: 'approved',
        reviewNotes: 'looks good',
      });

      const subscription = await admin.tenantSubscription.findUniqueOrThrow({
        where: { organizationId: org.id },
      });
      expect(subscription.status).toBe('active');
      expect(subscription.planId).toBe(plan.id);
      expect(subscription.billingCycle).toBe('monthly');

      const checkoutRow = await admin.checkout.findUniqueOrThrow({
        where: { id: checkout.id },
      });
      expect(checkoutRow.status).toBe('completed');

      // A second approve attempt is rejected, not double-applied.
      await request(app.getHttpServer())
        .post(`/payments/${payment.id}/approve`)
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .send({})
        .expect(409);
    });

    it('reject() marks the Payment failed and never touches tenant_subscriptions', async () => {
      const { owner, org, payment } = await arrangeCheckoutAndPayment('lifecycle-reject');
      await submitProof(org.id, payment.id, owner.accessToken);

      const beforeSubscription = await admin.tenantSubscription.findUniqueOrThrow({
        where: { organizationId: org.id },
      });

      const reviewer = await signUpAndSignIn(app, 'lifecycle-reject-reviewer');
      await makePlatformOwner(admin, reviewer.userId);

      const rejectRes = await request(app.getHttpServer())
        .post(`/payments/${payment.id}/reject`)
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .send({ notes: 'proof does not match the amount' })
        .expect(201);

      expect(rejectRes.body).toMatchObject({
        status: 'failed',
        reviewStatus: 'rejected',
        reviewNotes: 'proof does not match the amount',
      });

      const afterSubscription = await admin.tenantSubscription.findUniqueOrThrow({
        where: { organizationId: org.id },
      });
      expect(afterSubscription.status).toBe(beforeSubscription.status);
      expect(afterSubscription.planId).toBe(beforeSubscription.planId);
    });

    it("reject requires 'notes' (actionable reason) — matches the frontend's own floor", async () => {
      const { owner, org, payment } = await arrangeCheckoutAndPayment(
        'lifecycle-reject-notes',
      );
      await submitProof(org.id, payment.id, owner.accessToken);
      const reviewer = await signUpAndSignIn(app, 'lifecycle-reject-notes-reviewer');
      await makePlatformOwner(admin, reviewer.userId);

      await request(app.getHttpServer())
        .post(`/payments/${payment.id}/reject`)
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .send({ notes: 'short' })
        .expect(400);
    });

    it('a Platform Owner who is ALSO a member of the paying organization cannot approve/reject its own payment (real backend enforcement, not UX-only)', async () => {
      const owner = await signUpAndSignIn(app, 'self-review-owner');
      await makePlatformOwner(admin, owner.userId);
      const org = await seedOrganizationWithOwner(admin, owner.userId, 'self-review-org');
      const plan = await seedPricedPlan(admin, 'self-review-plan');
      await admin.tenantSubscription.create({
        data: { organizationId: org.id, planId: plan.id, status: 'trialing' },
      });
      const method = await seedPaymentMethod(admin, 'self-review-method');

      const checkoutRes = await request(app.getHttpServer())
        .post(`/organizations/${org.id}/checkouts`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          target: { type: 'plan_subscription', planKey: plan.key },
          idempotencyKey: 'self-review-idem',
        })
        .expect(201);
      const paymentRes = await request(app.getHttpServer())
        .post(`/organizations/${org.id}/payments`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ checkoutId: checkoutRes.body.id, methodKey: method.key })
        .expect(201);
      await submitProof(org.id, paymentRes.body.id, owner.accessToken);

      await request(app.getHttpServer())
        .post(`/payments/${paymentRes.body.id}/approve`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({})
        .expect(403);
    });

    it('cancelPayment moves a non-terminal Payment to cancelled', async () => {
      const { owner, org, payment } = await arrangeCheckoutAndPayment('lifecycle-cancel');

      const response = await request(app.getHttpServer())
        .post(`/organizations/${org.id}/payments/${payment.id}/cancel`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(201);

      expect(response.body.status).toBe('cancelled');
    });

    it('createPaymentIntent is real and callable, and honestly reports no gateway is connected', async () => {
      const { owner, org, checkout } =
        await arrangeCheckoutAndPayment('lifecycle-intent');

      await request(app.getHttpServer())
        .post(`/organizations/${org.id}/payments/intents`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ checkoutId: checkout.id })
        .expect(409);
    });

    it('GET .../invoices is real, RLS-protected, and genuinely empty (no invoice-generation trigger exists yet)', async () => {
      const owner = await signUpAndSignIn(app, 'invoices-owner');
      const org = await seedOrganizationWithOwner(admin, owner.userId, 'invoices-org');

      const response = await request(app.getHttpServer())
        .get(`/organizations/${org.id}/invoices`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      expect(response.body).toEqual({
        items: [],
        pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 1 },
      });
    });
  });

  describe('payment webhook — signature verification and idempotent redelivery', () => {
    it('rejects a request with a missing or invalid signature', async () => {
      const { payment } = await arrangeCheckoutAndPayment('webhook-badsig');
      const event = {
        id: `evt-${Date.now()}`,
        type: 'payment.succeeded',
        paymentId: payment.id,
        occurredAt: new Date().toISOString(),
      };

      await request(app.getHttpServer())
        .post('/payments/webhook')
        .send(event)
        .expect(400);
      await request(app.getHttpServer())
        .post('/payments/webhook')
        .set('x-atlas-webhook-signature', 'deadbeef')
        .send(event)
        .expect(400);
    });

    it('returns 404 for a signed event referencing an unknown Payment', async () => {
      const event = {
        id: `evt-unknown-${Date.now()}`,
        type: 'payment.succeeded',
        paymentId: '00000000-0000-0000-0000-000000000000',
        occurredAt: new Date().toISOString(),
      };
      await request(app.getHttpServer())
        .post('/payments/webhook')
        .set('x-atlas-webhook-signature', signWebhookEvent(event))
        .send(event)
        .expect(404);
    });

    it('a correctly signed payment.succeeded event, delivered twice, produces exactly ONE payment_webhook_events row and ONE state transition — never a double-apply', async () => {
      const { owner, org, plan, payment } =
        await arrangeCheckoutAndPayment('webhook-replay');
      await submitProof(org.id, payment.id, owner.accessToken);

      const event = {
        id: `evt-replay-${Date.now()}`,
        type: 'payment.succeeded',
        paymentId: payment.id,
        occurredAt: new Date().toISOString(),
      };
      const signature = signWebhookEvent(event);

      await request(app.getHttpServer())
        .post('/payments/webhook')
        .set('x-atlas-webhook-signature', signature)
        .send(event)
        .expect(200);
      await request(app.getHttpServer())
        .post('/payments/webhook')
        .set('x-atlas-webhook-signature', signature)
        .send(event)
        .expect(200);

      // Async (BullMQ) — poll until the worker has actually applied it.
      const deadline = Date.now() + 10_000;
      let paymentRow = await admin.payment.findUniqueOrThrow({
        where: { id: payment.id },
      });
      while (paymentRow.status !== 'succeeded' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        paymentRow = await admin.payment.findUniqueOrThrow({ where: { id: payment.id } });
      }
      expect(paymentRow.status).toBe('succeeded');

      const events = await admin.paymentWebhookEvent.findMany({
        where: { paymentId: payment.id },
      });
      expect(events).toHaveLength(1);

      const subscription = await admin.tenantSubscription.findUniqueOrThrow({
        where: { organizationId: org.id },
      });
      expect(subscription.planId).toBe(plan.id);
      expect(subscription.status).toBe('active');
    });
  });
});
