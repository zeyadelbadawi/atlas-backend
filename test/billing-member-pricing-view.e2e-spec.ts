/**
 * SEC-03(b) — the subscription reads stay open to every organization member,
 * but what the organization PAYS is the billing owner's alone (real
 * Postgres, RLS enforced).
 *
 * Owner decision (B0 ledger, 12 Oct 2026): making
 * `organizations/:id/{subscription,usage,add-ons}` owner-only was wrong —
 * members' dashboards read them for plan gating and the storage meter. The
 * revision keeps the reads open and strips pricing for non-owners:
 *   - `GET …/subscription`: `plan.pricing` and `priceChangeNotice` removed;
 *   - `GET …/subscription/lifecycle`: `plan.pricing` removed (it promised
 *     "no amount" while carrying one);
 *   - `GET …/add-ons`: each `addOn.pricing` removed;
 *   - `GET …/usage`: carries no price; unchanged, still readable.
 * Every gating field (status, plan id/key/limits/features/family/tier,
 * dates, add-on effect) is identical for every role.
 *
 * The Manager and Instructor carry exactly the permission sets the real
 * grant writes; "staff" is an academy `staff` member whose organization
 * membership is the instructor set — the same fixtures as
 * `staff-scope-analytics-revenue.e2e-spec.ts`.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedAddOn,
  seedOrganizationWithOwner,
  seedPlan,
  seedTenantAddOn,
} from './utils/db-admin';
import {
  ORGANIZATION_INSTRUCTOR_PERMISSIONS,
  ORGANIZATION_MANAGER_PERMISSIONS,
} from '../src/tenancy/constants/organization-permissions.constants';

interface Caller {
  readonly userId: string;
  readonly accessToken: string;
}

async function signUpAndSignIn(app: INestApplication, label: string): Promise<Caller> {
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

describe('Member view of subscription pricing (e2e) — SEC-03(b)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let orgId: string;
  const callers: Record<'owner' | 'manager' | 'instructor' | 'staff', Caller> =
    {} as never;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flush = testApp.flushRateLimitKeys;

    for (const role of ['owner', 'manager', 'instructor', 'staff'] as const) {
      callers[role] = await signUpAndSignIn(app, `sec03b-${role}`);
    }
    const org = await seedOrganizationWithOwner(
      admin,
      callers.owner.userId,
      'sec03b-org',
    );
    orgId = org.id;

    const plan = await seedPlan(admin, 'sec03b-plan', {
      pricing: { amount: 1190, currency: 'EGP', billingCycle: 'monthly' },
    });
    await admin.tenantSubscription.create({
      data: {
        organizationId: orgId,
        planId: plan.id,
        status: 'active',
        billingCycle: 'monthly',
        currentPeriodStart: new Date(Date.now() - 86_400_000),
        currentPeriodEnd: new Date(Date.now() + 29 * 86_400_000),
        // An owner-addressed renewal notice carrying the old and new price.
        priceChangeNotice: {
          planId: plan.id,
          planVersion: plan.version,
          billingCycle: 'monthly',
          fromPrice: { amount: 1190, currency: 'EGP' },
          toPrice: { amount: 1490, currency: 'EGP' },
          limitChanges: {},
          noticedAt: new Date().toISOString(),
        },
      },
    });
    const addOn = await seedAddOn(admin, 'sec03b-addon', { students: 100 }, [plan.key]);
    await admin.addOn.update({
      where: { id: addOn.id },
      data: { pricing: { amount: 250, currency: 'EGP', billingCycle: 'monthly' } },
    });
    await seedTenantAddOn(admin, orgId, addOn.id);
    // The usage row the recompute worker would write; its counts are not
    // under test, only that every role reads the same, price-free meter.
    await admin.tenantUsage.upsert({
      where: { organizationId: orgId },
      create: { organizationId: orgId, academies: 1, staff: 1, instructors: 1 },
      update: {},
    });

    const academy = await seedAcademy(admin, orgId, 'sec03b-academy');
    await seedAcademyMember(admin, academy.id, callers.owner.userId, 'owner');
    await admin.organizationMembership.createMany({
      data: [
        {
          organizationId: orgId,
          userId: callers.manager.userId,
          role: 'manager',
          permissions: [...ORGANIZATION_MANAGER_PERMISSIONS],
        },
        {
          organizationId: orgId,
          userId: callers.instructor.userId,
          role: 'instructor',
          permissions: [...ORGANIZATION_INSTRUCTOR_PERMISSIONS],
        },
        {
          organizationId: orgId,
          userId: callers.staff.userId,
          role: 'instructor',
          permissions: [...ORGANIZATION_INSTRUCTOR_PERMISSIONS],
        },
      ],
    });
    await seedAcademyMember(admin, academy.id, callers.manager.userId, 'manager');
    await seedAcademyMember(admin, academy.id, callers.instructor.userId, 'instructor');
    await seedAcademyMember(admin, academy.id, callers.staff.userId, 'staff');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
  });

  const get = (path: string, caller: Caller) =>
    request(app.getHttpServer())
      .get(`/organizations/${orgId}${path}`)
      .set('Authorization', `Bearer ${caller.accessToken}`)
      .expect(200);

  /** Everything plan gating reads — must be identical for every role. */
  function gatingView(body: Record<string, unknown>) {
    const plan = body.plan as Record<string, unknown>;
    return {
      status: body.status,
      planId: body.planId,
      currentPeriodEnd: body.currentPeriodEnd,
      cancelAtPeriodEnd: body.cancelAtPeriodEnd,
      plan: {
        id: plan.id,
        key: plan.key,
        name: plan.name,
        limits: plan.limits,
        features: plan.features,
        family: plan.family,
        tier: plan.tier,
      },
    };
  }

  it('the owner sees the plan price, the renewal notice and add-on prices', async () => {
    const subscription = await get('/subscription', callers.owner);
    expect(subscription.body.plan.pricing).toEqual({
      amount: 1190,
      currency: 'EGP',
      billingCycle: 'monthly',
    });
    expect(subscription.body.priceChangeNotice).toMatchObject({
      fromPrice: { amount: 1190, currency: 'EGP' },
      toPrice: { amount: 1490, currency: 'EGP' },
    });

    const lifecycle = await get('/subscription/lifecycle', callers.owner);
    expect(lifecycle.body.plan.pricing).toMatchObject({ amount: 1190 });

    const addOns = await get('/add-ons', callers.owner);
    expect(addOns.body).toHaveLength(1);
    expect(addOns.body[0].addOn.pricing).toMatchObject({ amount: 250, currency: 'EGP' });
  });

  for (const role of ['manager', 'instructor', 'staff'] as const) {
    it(`a ${role} still reads every gating field, but no price`, async () => {
      const owner = await get('/subscription', callers.owner);
      const subscription = await get('/subscription', callers[role]);
      expect(gatingView(subscription.body)).toEqual(gatingView(owner.body));
      expect(subscription.body.plan).not.toHaveProperty('pricing');
      expect(subscription.body).not.toHaveProperty('priceChangeNotice');
      // Nothing that looks like an amount survives anywhere in the body.
      expect(JSON.stringify(subscription.body)).not.toMatch(/1190|1490|"amount"/);

      const ownerLifecycle = await get('/subscription/lifecycle', callers.owner);
      const lifecycle = await get('/subscription/lifecycle', callers[role]);
      expect(lifecycle.body.lifecycle).toBe(ownerLifecycle.body.lifecycle);
      expect(lifecycle.body.hasAccess).toBe(ownerLifecycle.body.hasAccess);
      expect(lifecycle.body.plan.limits).toEqual(ownerLifecycle.body.plan.limits);
      expect(lifecycle.body.plan.features).toEqual(ownerLifecycle.body.plan.features);
      expect(lifecycle.body.plan).not.toHaveProperty('pricing');
      expect(JSON.stringify(lifecycle.body)).not.toMatch(/"amount"/);

      const ownerAddOns = await get('/add-ons', callers.owner);
      const addOns = await get('/add-ons', callers[role]);
      expect(addOns.body).toHaveLength(1);
      expect(addOns.body[0].addOnId).toBe(ownerAddOns.body[0].addOnId);
      expect(addOns.body[0].addOn.key).toBe(ownerAddOns.body[0].addOn.key);
      expect(addOns.body[0].addOn.effect).toEqual(ownerAddOns.body[0].addOn.effect);
      expect(addOns.body[0].addOn).not.toHaveProperty('pricing');

      // The storage meter's read: no price in it, identical for everyone.
      const ownerUsage = await get('/usage', callers.owner);
      const usage = await get('/usage', callers[role]);
      // Limits compared rather than the whole body: a background recompute
      // may refresh the counts between the two reads.
      const limits = (body: Record<string, { limit?: unknown }>) =>
        Object.fromEntries(
          Object.entries(body)
            .filter(([, metric]) => metric && typeof metric === 'object')
            .map(([key, metric]) => [key, metric.limit]),
        );
      expect(limits(usage.body)).toEqual(limits(ownerUsage.body));
      expect(JSON.stringify(usage.body)).not.toMatch(/pricing|"amount"|currency/);
    });
  }

  it('the billing mutations stay owner-only (unchanged)', async () => {
    for (const role of ['manager', 'instructor', 'staff'] as const) {
      await request(app.getHttpServer())
        .post(`/organizations/${orgId}/subscription/price-change-notice/dismiss`)
        .set('Authorization', `Bearer ${callers[role].accessToken}`)
        .expect(403);
    }
  });
});
