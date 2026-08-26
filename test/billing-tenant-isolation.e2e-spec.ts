/**
 * Atlas Subscription Billing tenant-isolation suite — P12-TENANT-001..005
 * (master plan §18), extending the permanent tenant-isolation suite
 * established in `tenant-isolation.e2e-spec.ts` (P2) through
 * `p7-tenant-isolation.e2e-spec.ts` (P7) — one file per phase, same
 * pattern. Exercised through the real HTTP surface; the pure DB-level RLS
 * proof lives in `rls-billing.e2e-spec.ts`.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedOrganizationWithOwner,
  seedPaymentMethod,
} from './utils/db-admin';
import type { Plan, PrismaClient } from '@prisma/client';

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

async function seedPricedPlan(admin: PrismaClient, keyLabel: string): Promise<Plan> {
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
      pricing: { amount: 50, currency: 'USD', billingCycle: 'monthly' },
    },
  });
}

describe('Atlas Subscription Billing tenant isolation (e2e) — P12-TENANT-001..005', () => {
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

  async function seedOrgWithCheckoutAndPayment(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const plan = await seedPricedPlan(admin, `${label}-plan`);
    await admin.tenantSubscription.create({
      data: { organizationId: org.id, planId: plan.id, status: 'trialing' },
    });
    const method = await seedPaymentMethod(admin, `${label}-method`);

    const checkoutRes = await request(app.getHttpServer())
      .post(`/organizations/${org.id}/checkouts`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        target: { type: 'plan_subscription', planKey: plan.key },
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

  it("P12-TENANT-001: an Organization B member cannot read Organization A's Checkout by direct id, through Organization B's own URL", async () => {
    const { checkout } = await seedOrgWithCheckoutAndPayment('t12-001-a');
    const orgBOwner = await signUpAndSignIn(app, 't12-001-b-owner');
    const orgB = await seedOrganizationWithOwner(
      admin,
      orgBOwner.userId,
      't12-001-b-org',
    );

    await request(app.getHttpServer())
      .get(`/organizations/${orgB.id}/checkouts/${checkout.id}`)
      .set('Authorization', `Bearer ${orgBOwner.accessToken}`)
      .expect(404);
  });

  it("P12-TENANT-002: an Organization B member cannot read Organization A's Payment through Organization B's own URL, even though B is a real member of B", async () => {
    const { payment } = await seedOrgWithCheckoutAndPayment('t12-002-a');
    const orgBOwner = await signUpAndSignIn(app, 't12-002-b-owner');
    const orgB = await seedOrganizationWithOwner(
      admin,
      orgBOwner.userId,
      't12-002-b-org',
    );

    await request(app.getHttpServer())
      .get(`/organizations/${orgB.id}/payments/${payment.id}`)
      .set('Authorization', `Bearer ${orgBOwner.accessToken}`)
      .expect(404);
  });

  it("P12-TENANT-003: Organization B's payment history list never includes Organization A's Payment, even with a wide page size", async () => {
    const { payment: paymentA } = await seedOrgWithCheckoutAndPayment('t12-003-a');
    const { owner: orgBOwner, org: orgB } =
      await seedOrgWithCheckoutAndPayment('t12-003-b');

    const list = await request(app.getHttpServer())
      .get(`/organizations/${orgB.id}/payments`)
      .query({ pageSize: 100 })
      .set('Authorization', `Bearer ${orgBOwner.accessToken}`)
      .expect(200);
    const ids = list.body.items.map((p: { id: string }) => p.id);
    expect(ids).not.toContain(paymentA.id);
  });

  it("P12-TENANT-004: Organization B's owner cannot cancel Organization A's Payment by supplying Organization A's payment id under Organization B's own URL", async () => {
    const { payment } = await seedOrgWithCheckoutAndPayment('t12-004-a');
    const orgBOwner = await signUpAndSignIn(app, 't12-004-b-owner');
    const orgB = await seedOrganizationWithOwner(
      admin,
      orgBOwner.userId,
      't12-004-b-org',
    );

    await request(app.getHttpServer())
      .post(`/organizations/${orgB.id}/payments/${payment.id}/cancel`)
      .set('Authorization', `Bearer ${orgBOwner.accessToken}`)
      .expect(404);

    const stillPending = await admin.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    expect(stillPending.status).toBe('pending');
  });

  it("P12-TENANT-005: a non-platform-owner from any organization, including the payer's own owner, cannot reach the flat /payments Platform Owner review surface", async () => {
    const { owner } = await seedOrgWithCheckoutAndPayment('t12-005-a');

    await request(app.getHttpServer())
      .get('/payments')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(403);
  });

  it('P12-TENANT-006: a Platform Owner approving a fabricated/nonexistent payment id gets a real 404, never a silent no-op success', async () => {
    const reviewer = await signUpAndSignIn(app, 't12-006-reviewer');
    await makePlatformOwner(admin, reviewer.userId);

    await request(app.getHttpServer())
      .post('/payments/00000000-0000-0000-0000-000000000000/approve')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({})
      .expect(404);
  });
});
