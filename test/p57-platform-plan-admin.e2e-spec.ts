/**
 * P57 — Platform-Owner plan administration (P57-PLAN-001..016).
 *
 * WHAT THESE PROVE THAT A UNIT TEST CANNOT. Three things, all of which
 * live in the database rather than in application code:
 *
 *   - `PlatformOwnerGuard` re-reads `users.is_platform_owner` per request,
 *     so "a tenant owner is refused" is only meaningful against a real row.
 *   - The concurrency contract is the UPDATE's WHERE clause: the database
 *     decides the race, not the service.
 *   - Price history is read back out of `audit_log_entries` under the
 *     `_platform_select` RLS policy, in `runInUserContext` — a mocked
 *     client would return rows RLS would actually refuse.
 *
 * Archive is asserted against a plan created by this suite, never against
 * a seeded catalog plan, so the shared dev database is not mutated into a
 * state later specs depend on.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma, seedOrganizationWithOwner } from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

const PASSWORD = 'correct-horse-battery';

/** A complete, valid limit set — every `PlanLimitKey`, as the DTO requires. */
const LIMITS = {
  academies: 1,
  students: 10,
  instructors: 1,
  staff: 1,
  courses: 5,
  generalStorage: 1,
  videoStorage: 1,
  recordedSessions: 1,
};

/** A complete, valid feature set — every `PlanFeatureKey`. */
const FEATURES = {
  cms: true,
  seo: false,
  seoAdvanced: false,
  marketing: false,
  marketingAdvanced: false,
  analytics: false,
  analyticsAdvanced: false,
  customDomain: false,
  themes: true,
  multipleThemes: false,
  backup: false,
  liveSessions: false,
};

describe('P57 platform plan administration (e2e) — P57-PLAN-001..016', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let platformOwnerToken: string;
  let tenantOwnerToken: string;
  const createdPlanKeys: string[] = [];

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;

    platformOwnerToken = (await seedPlatformOwner('p57-po')).token;
    tenantOwnerToken = (await seedTenantOwner('p57-tenant')).token;
  });

  afterAll(async () => {
    // Only plans this suite created — seeded catalog plans are left alone.
    if (createdPlanKeys.length > 0) {
      await admin.plan.deleteMany({ where: { key: { in: createdPlanKeys } } });
    }
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  async function signUp(label: string) {
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: `${label} user`, email, password: PASSWORD })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      email,
      userId: signIn.body.user.id as string,
      token: signIn.body.accessToken as string,
    };
  }

  async function seedPlatformOwner(label: string) {
    const account = await signUp(label);
    await admin.user.update({
      where: { id: account.userId },
      data: { isPlatformOwner: true },
    });
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: account.email, password: PASSWORD })
      .expect(200);
    return { ...account, token: signIn.body.accessToken as string };
  }

  async function seedTenantOwner(label: string) {
    const account = await signUp(label);
    await seedOrganizationWithOwner(admin, account.userId, `${label}-org`);
    return account;
  }

  function uniqueKey(label: string): string {
    const key = `p57-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    createdPlanKeys.push(key);
    return key;
  }

  async function createPlan(overrides: Record<string, unknown> = {}) {
    const key = uniqueKey('plan');
    const response = await request(app.getHttpServer())
      .post('/platform-plans')
      .set('Authorization', `Bearer ${platformOwnerToken}`)
      .send({
        key,
        name: `Plan ${key}`,
        displayOrder: 0, // 0 keeps it out of the customer-facing catalog
        limits: LIMITS,
        features: FEATURES,
        pricing: { amount: 10, currency: 'USD', billingCycle: 'monthly' },
        ...overrides,
      })
      .expect(201);
    return response.body as { id: string; key: string; version: number };
  }

  // ---------------- authorization ----------------

  it('P57-PLAN-001 — every write route refuses an UNAUTHENTICATED caller', async () => {
    await request(app.getHttpServer()).post('/platform-plans').send({}).expect(401);
    await request(app.getHttpServer()).patch('/platform-plans/growth').send({}).expect(401);
    await request(app.getHttpServer()).post('/platform-plans/growth/archive').send({}).expect(401);
    await request(app.getHttpServer()).get('/platform-plans/growth/history').expect(401);
  });

  it('P57-PLAN-002 — a real TENANT OWNER is refused on every write route', async () => {
    // Not a permission string: `PlatformOwnerGuard` reads the user's own
    // `is_platform_owner` column, which no organization role can grant.
    const auth = { Authorization: `Bearer ${tenantOwnerToken}` };
    await request(app.getHttpServer()).post('/platform-plans').set(auth).send({}).expect(403);
    await request(app.getHttpServer())
      .patch('/platform-plans/growth')
      .set(auth)
      .send({ expectedVersion: 0 })
      .expect(403);
    await request(app.getHttpServer())
      .post('/platform-plans/growth/archive')
      .set(auth)
      .send({ expectedVersion: 0 })
      .expect(403);
    await request(app.getHttpServer())
      .get('/platform-plans/growth/history')
      .set(auth)
      .expect(403);
  });

  // ---------------- create ----------------

  it('P57-PLAN-003 — a Platform Owner can create a plan', async () => {
    const plan = await createPlan();
    expect(plan.version).toBe(0);

    const row = await admin.plan.findUnique({ where: { key: plan.key } });
    expect(row?.name).toContain('Plan p57-plan');
  });

  it('P57-PLAN-004 — a duplicate key is refused with 409', async () => {
    const plan = await createPlan();
    await request(app.getHttpServer())
      .post('/platform-plans')
      .set('Authorization', `Bearer ${platformOwnerToken}`)
      .send({
        key: plan.key,
        name: 'Duplicate',
        displayOrder: 0,
        limits: LIMITS,
        features: FEATURES,
      })
      .expect(409);
  });

  it('P57-PLAN-005 — an unknown limit key is refused, never silently stored', async () => {
    // A typo'd key would become an entitlement nobody holds, silently.
    await request(app.getHttpServer())
      .post('/platform-plans')
      .set('Authorization', `Bearer ${platformOwnerToken}`)
      .send({
        key: uniqueKey('badlimit'),
        name: 'Bad',
        displayOrder: 0,
        limits: { ...LIMITS, notARealLimit: 5 },
        features: FEATURES,
      })
      .expect(400);
  });

  it('P57-PLAN-006 — an INCOMPLETE feature set is refused', async () => {
    await request(app.getHttpServer())
      .post('/platform-plans')
      .set('Authorization', `Bearer ${platformOwnerToken}`)
      .send({
        key: uniqueKey('badfeat'),
        name: 'Bad',
        displayOrder: 0,
        limits: LIMITS,
        features: { cms: true },
      })
      .expect(400);
  });

  // ---------------- concurrency ----------------

  it('P57-PLAN-007 — a STALE expectedVersion is refused with 409', async () => {
    const plan = await createPlan();

    await request(app.getHttpServer())
      .patch(`/platform-plans/${plan.key}`)
      .set('Authorization', `Bearer ${platformOwnerToken}`)
      .send({ expectedVersion: plan.version, name: 'First write' })
      .expect(200);

    const conflict = await request(app.getHttpServer())
      .patch(`/platform-plans/${plan.key}`)
      .set('Authorization', `Bearer ${platformOwnerToken}`)
      .send({ expectedVersion: plan.version, name: 'Second write' })
      .expect(409);

    expect(conflict.body.error.messageKey).toBe('errors.concurrency.staleVersion');

    // The losing write must not have landed.
    const row = await admin.plan.findUnique({ where: { key: plan.key } });
    expect(row?.name).toBe('First write');
  });

  it('P57-PLAN-008 — version increments on every successful write', async () => {
    const plan = await createPlan();
    const first = await request(app.getHttpServer())
      .patch(`/platform-plans/${plan.key}`)
      .set('Authorization', `Bearer ${platformOwnerToken}`)
      .send({ expectedVersion: 0, displayOrder: 0, name: 'v1' })
      .expect(200);
    expect(first.body.version).toBe(1);
  });

  // ---------------- price history (the audit-backed store) ----------------

  it('P57-PLAN-009 — a pricing change is recorded with from/to, actor and timestamp', async () => {
    const plan = await createPlan({
      pricing: { amount: 50, currency: 'USD', billingCycle: 'monthly' },
    });

    await request(app.getHttpServer())
      .patch(`/platform-plans/${plan.key}`)
      .set('Authorization', `Bearer ${platformOwnerToken}`)
      .send({
        expectedVersion: 0,
        pricing: { amount: 75, currency: 'USD', billingCycle: 'monthly' },
      })
      .expect(200);

    const history = await request(app.getHttpServer())
      .get(`/platform-plans/${plan.key}/history`)
      .set('Authorization', `Bearer ${platformOwnerToken}`)
      .expect(200);

    const pricingEntry = history.body.items.find(
      (entry: { action: string }) => entry.action === 'plan.pricing_changed',
    );
    expect(pricingEntry).toBeDefined();
    expect(pricingEntry.changes.pricing.from.amount).toBe(50);
    expect(pricingEntry.changes.pricing.to.amount).toBe(75);
    expect(pricingEntry.actor.id).toBeDefined();
    expect(pricingEntry.occurredAt).toBeDefined();
  });

  it('P57-PLAN-010 — pricing and trial changes are SEPARATE actions, so history is filterable', async () => {
    const plan = await createPlan();
    await request(app.getHttpServer())
      .patch(`/platform-plans/${plan.key}`)
      .set('Authorization', `Bearer ${platformOwnerToken}`)
      .send({
        expectedVersion: 0,
        pricing: { amount: 99, currency: 'USD', billingCycle: 'yearly' },
        trialEligible: true,
        trialDurationDays: 7,
        name: 'Renamed',
      })
      .expect(200);

    const history = await request(app.getHttpServer())
      .get(`/platform-plans/${plan.key}/history`)
      .set('Authorization', `Bearer ${platformOwnerToken}`)
      .expect(200);

    const actions = history.body.items.map((entry: { action: string }) => entry.action);
    expect(actions).toContain('plan.pricing_changed');
    expect(actions).toContain('plan.trial_config_changed');
    expect(actions).toContain('plan.updated');
  });

  it('P57-PLAN-011 — history is paginated', async () => {
    const plan = await createPlan();
    for (let i = 1; i <= 3; i += 1) {
      await request(app.getHttpServer())
        .patch(`/platform-plans/${plan.key}`)
        .set('Authorization', `Bearer ${platformOwnerToken}`)
        .send({ expectedVersion: i - 1, name: `Rev ${i}` })
        .expect(200);
    }

    const page = await request(app.getHttpServer())
      .get(`/platform-plans/${plan.key}/history?page=1&pageSize=2`)
      .set('Authorization', `Bearer ${platformOwnerToken}`)
      .expect(200);

    expect(page.body.items).toHaveLength(2);
    expect(page.body.pagination.totalItems).toBeGreaterThanOrEqual(4);
  });

  it('P57-PLAN-012 — a no-op edit still validates the version', async () => {
    const plan = await createPlan();
    // Nothing actually changes, but a stale client must still be told so
    // rather than being told "saved".
    await request(app.getHttpServer())
      .patch(`/platform-plans/${plan.key}`)
      .set('Authorization', `Bearer ${platformOwnerToken}`)
      .send({ expectedVersion: 99 })
      .expect(409);
  });

  // ---------------- archive ----------------

  it('P57-PLAN-013 — archiving sets status AND displayOrder, and is audited', async () => {
    const plan = await createPlan({ displayOrder: 5 });

    await request(app.getHttpServer())
      .post(`/platform-plans/${plan.key}/archive`)
      .set('Authorization', `Bearer ${platformOwnerToken}`)
      .send({ expectedVersion: 0 })
      .expect(201);

    const row = await admin.plan.findUnique({ where: { key: plan.key } });
    // BOTH halves of `CUSTOMER_FACING_WHERE` — setting only one would leave
    // the plan reachable through the other.
    expect(row?.status).toBe('archived');
    expect(row?.displayOrder).toBe(0);

    const history = await request(app.getHttpServer())
      .get(`/platform-plans/${plan.key}/history`)
      .set('Authorization', `Bearer ${platformOwnerToken}`)
      .expect(200);
    expect(
      history.body.items.some((e: { action: string }) => e.action === 'plan.archived'),
    ).toBe(true);
  });

  it('P57-PLAN-014 — archiving twice is refused', async () => {
    const plan = await createPlan();
    await request(app.getHttpServer())
      .post(`/platform-plans/${plan.key}/archive`)
      .set('Authorization', `Bearer ${platformOwnerToken}`)
      .send({ expectedVersion: 0 })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/platform-plans/${plan.key}/archive`)
      .set('Authorization', `Bearer ${platformOwnerToken}`)
      .send({ expectedVersion: 1 })
      .expect(409);
  });

  it('P57-PLAN-015 — an archived plan leaves existing data intact (no destructive change)', async () => {
    const plan = await createPlan();
    const before = await admin.plan.findUnique({ where: { key: plan.key } });

    await request(app.getHttpServer())
      .post(`/platform-plans/${plan.key}/archive`)
      .set('Authorization', `Bearer ${platformOwnerToken}`)
      .send({ expectedVersion: 0 })
      .expect(201);

    const after = await admin.plan.findUnique({ where: { key: plan.key } });
    // The row survives with its limits/features/pricing untouched — archive
    // is deactivation, never deletion.
    expect(after).not.toBeNull();
    expect(after?.limits).toEqual(before?.limits);
    expect(after?.features).toEqual(before?.features);
    expect(after?.pricing).toEqual(before?.pricing);
  });

  // ---------------- limit impact preview ----------------

  it('P57-PLAN-016 — the limit preview reports impact WITHOUT changing anything', async () => {
    const plan = await createPlan();
    const before = await admin.plan.findUnique({ where: { key: plan.key } });

    const preview = await request(app.getHttpServer())
      .post(`/platform-plans/${plan.key}/limits/preview`)
      .set('Authorization', `Bearer ${platformOwnerToken}`)
      .send({ limits: { ...LIMITS, students: 0 } })
      .expect(200);

    expect(Array.isArray(preview.body.affected)).toBe(true);
    // `recordedSessions` has no `tenant_usage` column, so it is reported as
    // unmeasurable rather than as zero impact.
    expect(preview.body.unmeasurableLimitKeys).toContain('recordedSessions');

    const after = await admin.plan.findUnique({ where: { key: plan.key } });
    expect(after?.limits).toEqual(before?.limits);
    expect(after?.version).toBe(before?.version);
  });
});
