/**
 * Atlas Subscription Payment — Generic Payment Gateway Integration
 * Readiness (2026-08-26) — functional/contract e2e suite for
 * `/platform-atlas-payment-provider`. Distinct from §5.8's Organization-
 * owned `organizations/:id/payment-settings/*` (course-payment
 * configuration, a completely different domain) — this file only exercises
 * Atlas's own subscription-payment provider configuration.
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
      pricing: { amount: 79, currency: 'USD', billingCycle: 'monthly' },
    },
  });
}

describe('Atlas Subscription Payment Provider (e2e)', () => {
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

  async function platformOwner(label: string) {
    const owner = await signUpAndSignIn(app, label);
    await makePlatformOwner(admin, owner.userId);
    return owner;
  }

  it('lists Manual Transfer as the one real provider available for Atlas Subscription Payment selection', async () => {
    const owner = await platformOwner('t-asp-available');

    const res = await request(app.getHttpServer())
      .get('/platform-atlas-payment-provider/available-providers')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(res.body).toEqual([{ providerKey: 'atlas_manual', displayName: 'Manual Transfer' }]);
  });

  it('a brand-new deployment resolves the effective provider to Manual Transfer — never a silent default to anything else', async () => {
    const owner = await platformOwner('t-asp-default');

    const res = await request(app.getHttpServer())
      .get('/platform-atlas-payment-provider')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(res.body.effectiveProviderKey).toBe('atlas_manual');
    expect(res.body.effectiveProviderDisplayName).toBe('Manual Transfer');
  });

  it('a Platform Owner can save, test, and enable a provider configuration end to end', async () => {
    const owner = await platformOwner('t-asp-lifecycle');

    const saved = await request(app.getHttpServer())
      .patch('/platform-atlas-payment-provider')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ providerKey: 'atlas_manual', config: {} })
      .expect(200);
    expect(saved.body.status).toBe('configured');
    expect(saved.body.enabled).toBe(false);

    // Cannot enable before a successful test-connection.
    await request(app.getHttpServer())
      .post('/platform-atlas-payment-provider/enable')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(409);

    const tested = await request(app.getHttpServer())
      .post('/platform-atlas-payment-provider/test-connection')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);
    expect(tested.body.status).toBe('verified');
    expect(tested.body.lastTestResult).toMatchObject({ success: true });

    const enabled = await request(app.getHttpServer())
      .post('/platform-atlas-payment-provider/enable')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);
    expect(enabled.body.enabled).toBe(true);

    const disabled = await request(app.getHttpServer())
      .post('/platform-atlas-payment-provider/disable')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);
    expect(disabled.body.enabled).toBe(false);
  });

  it('rejects saving a provider that is not registered as available — honest rejection, no fake gateway', async () => {
    const owner = await platformOwner('t-asp-invalid-provider');

    await request(app.getHttpServer())
      .patch('/platform-atlas-payment-provider')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ providerKey: 'stripe', config: { apiKey: 'sk_test_whatever' } })
      .expect(409);
  });

  it('test-connection is rejected with 404 when nothing has been configured yet', async () => {
    const owner = await platformOwner('t-asp-test-unconfigured');

    // A fresh Platform Owner user, but the singleton config row is shared
    // across this whole test file — reset it explicitly for isolation.
    await admin.atlasSubscriptionPaymentProviderConfig.deleteMany({});

    await request(app.getHttpServer())
      .post('/platform-atlas-payment-provider/test-connection')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(404);
  });

  it('never exposes encrypted/raw credential material through any response', async () => {
    const owner = await platformOwner('t-asp-secret-leak');

    const saved = await request(app.getHttpServer())
      .patch('/platform-atlas-payment-provider')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ providerKey: 'atlas_manual', config: { secretValue: 'super-secret-token' } })
      .expect(200);

    expect(saved.body).not.toHaveProperty('encryptedConfig');
    expect(saved.body).not.toHaveProperty('config');
    expect(JSON.stringify(saved.body)).not.toContain('super-secret-token');

    const fetched = await request(app.getHttpServer())
      .get('/platform-atlas-payment-provider')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(JSON.stringify(fetched.body)).not.toContain('super-secret-token');
  });

  it('an ordinary Organization member cannot read or write Atlas subscription payment provider configuration', async () => {
    const owner = await signUpAndSignIn(app, 't-asp-org-forbidden');
    await seedOrganizationWithOwner(admin, owner.userId, 't-asp-org-forbidden-org');

    await request(app.getHttpServer())
      .get('/platform-atlas-payment-provider')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .patch('/platform-atlas-payment-provider')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ providerKey: 'atlas_manual', config: {} })
      .expect(403);

    await request(app.getHttpServer())
      .post('/platform-atlas-payment-provider/test-connection')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .post('/platform-atlas-payment-provider/enable')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .get('/platform-atlas-payment-provider/available-providers')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(403);
  });

  it('an unauthenticated caller is rejected before reaching any handler', async () => {
    await request(app.getHttpServer()).get('/platform-atlas-payment-provider').expect(401);
  });

  it('P12 regression: createPaymentIntent still honestly reports no gateway is connected, even after Manual Transfer is fully configured/tested/enabled through the new provider config', async () => {
    const owner = await platformOwner('t-asp-p12-regression');

    // Fully configure, verify, and enable Manual Transfer through the new
    // Atlas Subscription Payment provider surface.
    await request(app.getHttpServer())
      .patch('/platform-atlas-payment-provider')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ providerKey: 'atlas_manual', config: {} })
      .expect(200);
    await request(app.getHttpServer())
      .post('/platform-atlas-payment-provider/test-connection')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);
    await request(app.getHttpServer())
      .post('/platform-atlas-payment-provider/enable')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);

    // The core P12 checkout/payment flow is completely unaffected —
    // ManualTransferProvider has no `createPaymentIntent` capability, so
    // this must still be the exact same honest 409 P12 always returned,
    // proving the core subscription payment business logic contains no
    // gateway-specific branching that could be fooled by "a provider is
    // now configured."
    const org = await seedOrganizationWithOwner(admin, owner.userId, 't-asp-p12-reg-org');
    const plan = await seedPricedPlan(admin, 't-asp-p12-reg-plan');
    await admin.tenantSubscription.create({
      data: { organizationId: org.id, planId: plan.id, status: 'trialing' },
    });
    await seedPaymentMethod(admin, 't-asp-p12-reg-method');

    const checkoutRes = await request(app.getHttpServer())
      .post(`/organizations/${org.id}/checkouts`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        target: { type: 'plan_subscription', planKey: plan.key },
        idempotencyKey: 't-asp-p12-reg-idem',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/organizations/${org.id}/payments/intents`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ checkoutId: checkoutRes.body.id })
      .expect(409);
  });
});
