/**
 * CF-23 / B0-BIL-02 — a priced add-on cannot be taken for free, and a
 * plan-restricted add-on cannot be installed or bought on another plan.
 *
 * Exercised over HTTP with a real database, the way a curl would: before
 * this guard, `POST /organizations/:id/add-ons/:key/install` activated any
 * published add-on (including the priced `extra-academy`) after checking
 * only the billing permission.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Plan, PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma, seedOrganizationWithOwner } from './utils/db-admin';

jest.setTimeout(30000);

async function signUpAndSignIn(app: INestApplication, label: string) {
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
    accessToken: signIn.body.accessToken as string,
  };
}

const unique = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function seedPlan(admin: PrismaClient, label: string): Promise<Plan> {
  return admin.plan.create({
    data: {
      key: unique(label),
      name: label,
      limits: {
        academies: 1,
        students: 100,
        instructors: 3,
        staff: 3,
        courses: 20,
        generalStorage: 10,
        videoStorage: 30,
      },
      features: { liveSessions: false },
      pricing: { amount: 1190, currency: 'EGP', billingCycle: 'monthly' },
    },
  });
}

describe('Add-on purchase guard (e2e) — CF-23', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let owner: { userId: string; accessToken: string };
  let orgId: string;
  let plan: Plan;
  const pricedKey = unique('priced-addon');
  const freeKey = unique('free-addon');
  const restrictedKey = unique('restricted-addon');

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flush = testApp.flushRateLimitKeys;

    owner = await signUpAndSignIn(app, 'addon-guard-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'addon-guard-org');
    orgId = org.id;
    plan = await seedPlan(admin, 'addon-guard-plan');
    await admin.tenantSubscription.create({
      data: { organizationId: orgId, planId: plan.id, status: 'trialing' },
    });

    await admin.addOn.create({
      data: {
        key: pricedKey,
        name: 'Priced',
        effect: { type: 'limit', limitKey: 'academies', amount: 2 },
        pricing: { amount: 450, currency: 'EGP', billingCycle: 'monthly' },
        catalogStatus: 'published',
      },
    });
    await admin.addOn.create({
      data: {
        key: freeKey,
        name: 'Free',
        effect: { type: 'feature', featureKey: 'liveSessions' },
        catalogStatus: 'published',
      },
    });
    await admin.addOn.create({
      data: {
        key: restrictedKey,
        name: 'Restricted',
        effect: { type: 'feature', featureKey: 'liveSessions' },
        compatiblePlanKeys: ['some-other-plan'],
        pricing: { amount: 300, currency: 'EGP', billingCycle: 'monthly' },
        catalogStatus: 'published',
      },
    });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
  });

  const post = (path: string, body: object) =>
    request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send(body);

  it('refuses installing a priced add-on without a purchase, and creates nothing', async () => {
    const res = await post(`/organizations/${orgId}/add-ons/${pricedKey}/install`, {
      confirm: true,
    }).expect(403);
    expect(res.body.error.messageKey).toBe('errors.addOns.purchaseRequired');
    const pricedAddOn = await admin.addOn.findUniqueOrThrow({
      where: { key: pricedKey },
    });
    const rows = await admin.tenantAddOn.count({
      where: { organizationId: orgId, addOnId: pricedAddOn.id },
    });
    expect(rows).toBe(0);
  });

  it('still installs a free add-on', async () => {
    await post(`/organizations/${orgId}/add-ons/${freeKey}/install`, {
      confirm: true,
    }).expect(200);
    const freeAddOn = await admin.addOn.findUniqueOrThrow({ where: { key: freeKey } });
    const row = await admin.tenantAddOn.findUnique({
      where: { organizationId_addOnId: { organizationId: orgId, addOnId: freeAddOn.id } },
    });
    expect(row).not.toBeNull();
  });

  it('refuses a checkout for an add-on restricted to other plans', async () => {
    const res = await post(`/organizations/${orgId}/checkouts`, {
      target: { type: 'add_on', addOnKey: restrictedKey },
      idempotencyKey: unique('restricted-checkout'),
    }).expect(403);
    expect(res.body.error.messageKey).toBe('errors.addOns.incompatiblePlan');
  });

  it('allows a checkout for a priced add-on with no plan restriction', async () => {
    await post(`/organizations/${orgId}/checkouts`, {
      target: { type: 'add_on', addOnKey: pricedKey },
      idempotencyKey: unique('priced-checkout'),
    }).expect(201);
  });
});
