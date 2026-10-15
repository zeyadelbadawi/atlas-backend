/**
 * B0-CAT-03 / B0-MED-03 — what `displayOrder = 0` (the Catalog containment
 * workflow's only change) does to a Premium-family plan on every customer
 * surface, against real Postgres as `atlas_app`.
 *
 * The plan here is a fixture with a unique key, so no other suite's catalog
 * changes; it is hidden and shown again with the same column change the
 * containment script makes (`display_order`, `version + 1`).
 *
 *   - hidden: gone from `/public/plans`, `/public/signup-options` and the
 *     signed-in `/plans` list; signup refuses it and creates nothing;
 *   - an organization ALREADY on the plan keeps it: its subscription still
 *     names the plan, the plan reads by key, and a renewal checkout for the
 *     same key is created (checkout and payment look plans up by key);
 *   - shown again: back in `/public/plans` with its original order;
 *   - B0-MED-03: the in-app trial endpoint refuses a hidden plan's id too
 *     (it was the one path that still accepted it), and starts no trial;
 */
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Plan, PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma, seedOrganizationWithOwner } from './utils/db-admin';
import type { IdentityConfig } from '../src/config/configuration';
import { TrialPolicyRepository } from '../src/plans/repositories/trial-policy.repository';

jest.setTimeout(30000);

const PASSWORD = 'correct-horse-battery';
const DAY = 24 * 60 * 60 * 1000;
const ORIGINAL_ORDER = 940;

describe('Catalog containment: a hidden Premium plan (e2e) — B0-CAT-03 / B0-MED-03', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let identityConfig: {
    signupOrganizationMode: IdentityConfig['signupOrganizationMode'];
  };
  let originalSignupMode: IdentityConfig['signupOrganizationMode'];
  let originalPolicy: { enabled: boolean; durationDays: number };
  let premium: Plan;

  async function signUpAndSignIn(label: string) {
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      userId: signIn.body.user.id as string,
      accessToken: signIn.body.accessToken as string,
    };
  }

  /** The containment script's change, on this fixture only. */
  async function setDisplayOrder(order: number): Promise<void> {
    await admin.$executeRaw`
      UPDATE plans SET display_order = ${order}, version = version + 1, updated_at = now()
       WHERE id = ${premium.id} AND family = 'premium'`;
  }

  const publicKeys = async (): Promise<string[]> => {
    const res = await request(app.getHttpServer()).get('/public/plans').expect(200);
    return (res.body as { key: string }[]).map((p) => p.key);
  };
  const signupOptionKeys = async (): Promise<string[]> => {
    const res = await request(app.getHttpServer())
      .get('/public/signup-options')
      .expect(200);
    return (res.body.trialPlans as { key: string }[]).map((p) => p.key);
  };

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    flush = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
    identityConfig = app
      .get(ConfigService)
      .getOrThrow<IdentityConfig>('identity') as never;
    originalSignupMode = identityConfig.signupOrganizationMode;
    const policy = await app.get(TrialPolicyRepository).findSingleton();
    originalPolicy = { enabled: policy.enabled, durationDays: policy.durationDays };
    premium = await admin.plan.create({
      data: {
        key: `contain-premium-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: 'Containment Premium',
        family: 'premium',
        tier: 'basic',
        displayOrder: ORIGINAL_ORDER,
        trialEligible: true,
        limits: {
          academies: 1,
          students: 20,
          instructors: 2,
          staff: 2,
          courses: 5,
          generalStorage: 2,
          videoStorage: 2,
        },
        features: { liveSessions: false },
        pricing: { amount: 49, currency: 'USD', billingCycle: 'monthly' },
      },
    });
  });

  beforeEach(async () => {
    await flush();
    identityConfig.signupOrganizationMode = 'on';
    await admin.trialPolicy.updateMany({ data: { enabled: true } });
  });

  afterAll(async () => {
    await admin.plan.update({
      where: { id: premium.id },
      data: { status: 'archived', displayOrder: 0 },
    });
    identityConfig.signupOrganizationMode = originalSignupMode;
    await admin.trialPolicy.updateMany({ data: originalPolicy });
    await admin.$disconnect();
    await app.close();
  });

  it('is customer-facing before the change (the production state today)', async () => {
    expect(await publicKeys()).toContain(premium.key);
    expect(await signupOptionKeys()).toContain(premium.key);
  });

  describe('after displayOrder -> 0', () => {
    let subscriber: { userId: string; accessToken: string };
    let subscriberOrgId: string;

    beforeAll(async () => {
      // An organization that bought the plan while it was public.
      subscriber = await signUpAndSignIn('contain-subscriber');
      subscriberOrgId = (
        await seedOrganizationWithOwner(admin, subscriber.userId, 'contain-sub-org')
      ).id;
      await admin.tenantSubscription.create({
        data: {
          organizationId: subscriberOrgId,
          planId: premium.id,
          status: 'active',
          billingCycle: 'monthly',
          currentPeriodStart: new Date(Date.now() - 20 * DAY),
          currentPeriodEnd: new Date(Date.now() + 10 * DAY),
        },
      });
      await setDisplayOrder(0);
    });

    it('is gone from GET /public/plans and GET /public/signup-options', async () => {
      expect(await publicKeys()).not.toContain(premium.key);
      expect(await signupOptionKeys()).not.toContain(premium.key);
    });

    it('is refused at signup, and the refused signup creates nothing', async () => {
      const email = uniqueTestEmail('contain-signup');
      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Contain Signup',
          email,
          password: PASSWORD,
          organizationName: `Contain Org ${randomUUID().slice(0, 8)}`,
          planId: premium.id,
        })
        .expect(400);
      expect(res.body.error.messageKey).toBe('errors.auth.signupPlanUnavailable');
      expect(await admin.user.count({ where: { email } })).toBe(0);
    });

    it('is gone from the signed-in plan list, but still reads by key', async () => {
      const list = await request(app.getHttpServer())
        .get('/plans')
        .query({ pageSize: 100 })
        .set('Authorization', `Bearer ${subscriber.accessToken}`)
        .expect(200);
      expect((list.body.items as { key: string }[]).map((p) => p.key)).not.toContain(
        premium.key,
      );

      const byKey = await request(app.getHttpServer())
        .get(`/plans/${premium.key}`)
        .set('Authorization', `Bearer ${subscriber.accessToken}`)
        .expect(200);
      expect(byKey.body).toMatchObject({
        key: premium.key,
        family: 'premium',
        displayOrder: 0,
      });
    });

    it('leaves an existing subscription untouched and lets it renew by key', async () => {
      const subscription = await admin.tenantSubscription.findUniqueOrThrow({
        where: { organizationId: subscriberOrgId },
      });
      expect(subscription).toMatchObject({ planId: premium.id, status: 'active' });

      const checkout = await request(app.getHttpServer())
        .post(`/organizations/${subscriberOrgId}/checkouts`)
        .set('Authorization', `Bearer ${subscriber.accessToken}`)
        .send({
          target: { type: 'plan_subscription', planKey: premium.key },
          billingCycle: 'monthly',
          idempotencyKey: `contain-renew-${randomUUID()}`,
        })
        .expect(201);
      expect(checkout.body.snapshot).toMatchObject({
        target: { type: 'plan_subscription', planKey: premium.key },
        price: { amountMinorUnits: 4900, currency: 'USD' },
      });
    });

    it('B0-MED-03: the in-app trial endpoint refuses a hidden plan id and starts no trial', async () => {
      const owner = await signUpAndSignIn('contain-trial');
      const org = await request(app.getHttpServer())
        .post('/organizations')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ name: `Contain Trial ${randomUUID().slice(0, 8)}` })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post(`/organizations/${org.body.id}/subscription/trial`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ confirm: true, planId: premium.id })
        .expect(403);
      expect(res.body.error.messageKey).toBe('errors.entitlement.noPlanAvailable');

      const subscription = await admin.tenantSubscription.findUnique({
        where: { organizationId: org.body.id },
      });
      expect(subscription?.planId).not.toBe(premium.id);
      expect(subscription?.status).not.toBe('trialing');
    });
  });

  it('revert (displayOrder back to its recorded value) makes it customer-facing again', async () => {
    await setDisplayOrder(ORIGINAL_ORDER);
    const row = await admin.plan.findUniqueOrThrow({ where: { id: premium.id } });
    expect(row.displayOrder).toBe(ORIGINAL_ORDER);
    expect(await publicKeys()).toContain(premium.key);
    expect(await signupOptionKeys()).toContain(premium.key);
  });
});
