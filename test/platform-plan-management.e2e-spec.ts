/**
 * Plan management (item 9 of the UX audit decisions) — the Platform Owner
 * plan list with subscriber counts, restoring an archived plan, the real
 * counts recorded when archiving, and editing an add-on's price.
 *
 * Against real Postgres because the counts are cross-tenant reads that
 * only the `*_platform_select` RLS policies allow (`runInUserContext`): a
 * mocked client would count rows RLS actually hides.
 *
 * Every plan here is created hidden (`displayOrder: 0`), so the customer
 * catalog, which other suites assert exactly, never sees it; they are
 * deleted (with their fixture subscriptions) in `afterAll`.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedOrganizationWithOwner,
  seedTenantSubscription,
} from './utils/db-admin';

const PASSWORD = 'correct-horse-battery';

const LIMITS = {
  academies: 1,
  students: 10,
  instructors: 1,
  staff: 1,
  courses: 5,
  generalStorage: 1,
  videoStorage: 1,
  videoStorageMinutes: 100,
  recordedSessions: 1,
};
const FEATURES = { liveSessions: false };

describe('Platform Owner plan management (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let poToken: string;
  let tenantToken: string;
  const createdPlanKeys: string[] = [];
  const createdAddOnKeys: string[] = [];
  const suite = `pm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  beforeAll(async () => {
    const testApp = await createTestApp({ fieldViolations: true });
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    await flushRateLimitKeys();

    const po = await signUp('pm-po');
    await admin.user.update({
      where: { id: po.userId },
      data: { isPlatformOwner: true },
    });
    poToken = (await signIn(po.email)).token;

    const tenant = await signUp('pm-tenant');
    await seedOrganizationWithOwner(admin, tenant.userId, `${suite}-tenant`);
    tenantToken = tenant.token;
  });

  afterAll(async () => {
    if (createdPlanKeys.length > 0) {
      const plans = await admin.plan.findMany({
        where: { key: { in: createdPlanKeys } },
        select: { id: true },
      });
      const ids = plans.map((plan) => plan.id);
      await admin.tenantSubscription.deleteMany({
        where: { OR: [{ planId: { in: ids } }, { scheduledPlanId: { in: ids } }] },
      });
      await admin.plan.deleteMany({ where: { id: { in: ids } } });
    }
    if (createdAddOnKeys.length > 0) {
      await admin.addOn.deleteMany({ where: { key: { in: createdAddOnKeys } } });
    }
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  const server = () => app.getHttpServer();
  const asPo = { Authorization: '' };
  beforeAll(() => {
    asPo.Authorization = `Bearer ${poToken}`;
  });

  async function signUp(label: string) {
    const email = uniqueTestEmail(label);
    await request(server())
      .post('/auth/register')
      .send({ name: `${label} user`, email, password: PASSWORD })
      .expect(201);
    const session = await signIn(email);
    return { email, userId: session.userId, token: session.token };
  }

  async function signIn(email: string) {
    const response = await request(server())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      userId: response.body.user.id as string,
      token: response.body.accessToken as string,
    };
  }

  async function createHiddenPlan(label: string) {
    const key = `${suite}-${label}`;
    createdPlanKeys.push(key);
    const response = await request(server())
      .post('/platform-plans')
      .set(asPo)
      .send({
        key,
        name: `PM ${key}`,
        displayOrder: 0,
        limits: LIMITS,
        features: FEATURES,
        pricing: { amount: 500, currency: 'EGP', billingCycle: 'monthly' },
      })
      .expect(201);
    return response.body as { id: string; key: string; version: number };
  }

  async function seedOrg(label: string) {
    const owner = await admin.user.create({
      data: {
        email: uniqueTestEmail(`${suite}-${label}`),
        name: `${suite} ${label}`,
        emailVerifiedAt: new Date(),
      },
    });
    return seedOrganizationWithOwner(admin, owner.id, `${suite}-${label}`);
  }

  async function listRow(key: string, visibility?: string) {
    const response = await request(server())
      .get('/platform-plans')
      .query({ search: key, ...(visibility ? { visibility } : {}) })
      .set(asPo)
      .expect(200);
    return (response.body.items as { key: string }[]).find((row) => row.key === key) as
      | (Record<string, unknown> & {
          version: number;
          subscribers: Record<string, number>;
        })
      | undefined;
  }

  // ---------------- authorization ----------------

  it('refuses the new routes to anonymous callers (401) and tenant owners (403)', async () => {
    await request(server()).get('/platform-plans').expect(401);
    await request(server()).post('/platform-plans/growth/restore').send({}).expect(401);
    await request(server()).patch('/platform-add-ons/x/pricing').send({}).expect(401);

    const asTenant = { Authorization: `Bearer ${tenantToken}` };
    await request(server()).get('/platform-plans').set(asTenant).expect(403);
    await request(server())
      .post('/platform-plans/growth/restore')
      .set(asTenant)
      .send({ expectedVersion: 0, displayOrder: 0 })
      .expect(403);
    await request(server())
      .patch('/platform-add-ons/x/pricing')
      .set(asTenant)
      .send({ amount: 10, currency: 'EGP', expectedVersion: 0 })
      .expect(403);
  });

  // ---------------- list + counts ----------------

  it('lists a hidden plan with paying, trialing and switching-in counts; ignores lapsed organizations', async () => {
    const plan = await createHiddenPlan('counted');
    const other = await createHiddenPlan('other');

    const paying = await seedOrg('paying');
    await seedTenantSubscription(admin, paying.id, plan.id, { status: 'active' });
    const trialing = await seedOrg('trialing');
    await seedTenantSubscription(admin, trialing.id, plan.id, {
      status: 'trialing',
      trialEndsAt: new Date(Date.now() + 7 * 86_400_000),
    });
    const lapsedTrial = await seedOrg('lapsed-trial');
    await seedTenantSubscription(admin, lapsedTrial.id, plan.id, {
      status: 'trialing',
      trialEndsAt: new Date(Date.now() - 86_400_000),
    });
    const expired = await seedOrg('expired');
    await seedTenantSubscription(admin, expired.id, plan.id, { status: 'expired' });
    const switching = await seedOrg('switching');
    await seedTenantSubscription(admin, switching.id, other.id, {
      status: 'active',
    });
    await admin.tenantSubscription.update({
      where: { organizationId: switching.id },
      data: {
        scheduledPlanId: plan.id,
        scheduledGrantedLimits: LIMITS,
        scheduledChangeAt: new Date(Date.now() + 10 * 86_400_000),
      },
    });

    const row = await listRow(plan.key, 'hidden');
    expect(row).toBeDefined();
    expect(row!.status).toBe('active');
    expect(row!.displayOrder).toBe(0);
    expect(row!.subscribers).toEqual({
      paying: 1,
      trialing: 1,
      scheduledIn: 1,
      foundingLocks: 0,
    });
    expect(typeof row!.createdAt).toBe('string');

    // The customer catalog never shows it.
    const catalog = await request(server()).get('/public/plans').expect(200);
    expect((catalog.body as { key: string }[]).map((p) => p.key)).not.toContain(plan.key);

    // Visibility filters are exclusive.
    expect(await listRow(plan.key, 'listed')).toBeUndefined();
    expect(await listRow(plan.key, 'archived')).toBeUndefined();
  });

  it('refuses an unknown visibility (400)', async () => {
    await request(server())
      .get('/platform-plans')
      .query({ visibility: 'draft' })
      .set(asPo)
      .expect(400);
  });

  // ---------------- archive + restore ----------------

  it('records the real subscriber counts when archiving, then restores the plan (hidden) with its history', async () => {
    const plan = await createHiddenPlan('archive-restore');
    const org = await seedOrg('archived-payer');
    await seedTenantSubscription(admin, org.id, plan.id, { status: 'active' });

    await request(server())
      .post(`/platform-plans/${plan.key}/archive`)
      .set(asPo)
      .send({ expectedVersion: plan.version })
      .expect(201);

    const archivedEntry = await admin.auditLogEntry.findFirstOrThrow({
      where: { action: 'plan.archived', targetId: plan.id },
    });
    expect(archivedEntry.context).toMatchObject({
      key: plan.key,
      subscriptionsAtArchive: 1,
      payingAtArchive: 1,
      trialingAtArchive: 0,
      foundingLocksAtArchive: 0,
    });

    const archived = await listRow(plan.key, 'archived');
    expect(archived?.status).toBe('archived');

    // A stale version is refused (409), and nothing changes.
    await request(server())
      .post(`/platform-plans/${plan.key}/restore`)
      .set(asPo)
      .send({ expectedVersion: plan.version, displayOrder: 0 })
      .expect(409);

    const restored = await request(server())
      .post(`/platform-plans/${plan.key}/restore`)
      .set(asPo)
      .send({ expectedVersion: archived!.version, displayOrder: 0 })
      .expect(200);
    expect(restored.body).toMatchObject({
      key: plan.key,
      status: 'active',
      displayOrder: 0,
    });

    // Restoring an active plan is a conflict.
    const again = await request(server())
      .post(`/platform-plans/${plan.key}/restore`)
      .set(asPo)
      .send({ expectedVersion: restored.body.version, displayOrder: 0 })
      .expect(409);
    expect(again.body.error.messageKey).toBe('errors.plan.notArchived');

    const history = await request(server())
      .get(`/platform-plans/${plan.key}/history`)
      .set(asPo)
      .expect(200);
    const actions = (history.body.items as { action: string }[]).map(
      (entry) => entry.action,
    );
    expect(actions).toEqual(expect.arrayContaining(['plan.archived', 'plan.restored']));
  });

  // ---------------- add-on pricing ----------------

  it('edits an add-on price (EGP, whole, non-zero), audited and version-guarded', async () => {
    const key = `${suite}-addon`;
    createdAddOnKeys.push(key);
    const addOn = await admin.addOn.create({
      data: {
        key,
        name: `ZZ Priced ${suite}`,
        description: 'An add-on whose price is edited.',
        effect: { type: 'feature', featureKey: 'liveSessions' },
        compatiblePlanKeys: [],
        catalogStatus: 'draft',
        pricing: { amount: 29, currency: 'USD', billingCycle: 'monthly' },
      },
    });

    // EGP only: the dollar price cannot be kept.
    const usd = await request(server())
      .patch(`/platform-add-ons/${key}/pricing`)
      .set(asPo)
      .send({ amount: 30, currency: 'USD', expectedVersion: addOn.version })
      .expect(400);
    expect(usd.body.error.violations).toEqual([
      { field: 'currency', messageKey: 'validation:unsupportedCurrency' },
    ]);

    await request(server())
      .patch(`/platform-add-ons/${key}/pricing`)
      .set(asPo)
      .send({ amount: 0, currency: 'EGP', expectedVersion: addOn.version })
      .expect(400);

    const saved = await request(server())
      .patch(`/platform-add-ons/${key}/pricing`)
      .set(asPo)
      .send({ amount: 450, currency: 'EGP', expectedVersion: addOn.version })
      .expect(200);
    expect(saved.body.pricing).toEqual({
      amount: 450,
      currency: 'EGP',
      billingCycle: 'monthly',
    });
    expect(saved.body.version).toBe(addOn.version + 1);

    // The old version is now stale.
    await request(server())
      .patch(`/platform-add-ons/${key}/pricing`)
      .set(asPo)
      .send({ amount: 500, currency: 'EGP', expectedVersion: addOn.version })
      .expect(409);

    const entry = await admin.auditLogEntry.findFirstOrThrow({
      where: { action: 'add_on.pricing_changed', targetId: addOn.id },
    });
    expect(entry.context).toMatchObject({ addOnKey: key });
  });
});
