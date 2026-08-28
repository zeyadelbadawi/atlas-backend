/**
 * Platform Analytics — functional + financial-correctness e2e suite
 * (Phase P16, master plan §21/§14). Covers `GET /platform-metrics` and
 * `GET /analytics/{overview,time-series/:metric,breakdown/:dimension}`:
 * Platform Owner access, non-owner/unauthenticated denial, date-range
 * filtering (including a genuinely-empty period), zero-denominator
 * safety, and — the highest-value scenarios here — that revenue
 * aggregation is financially correct: a failed payment must never count
 * as revenue, and a fully-refunded course sale must net to exactly zero
 * commission, not a residual non-zero amount.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedCourse,
  seedCourseOrder,
  seedOrganizationWithOwner,
  seedPayment,
  seedPlan,
  seedRevenueLedgerEntry,
  seedTenantSubscription,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

jest.setTimeout(30000);

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

describe('Platform Analytics — P16 (e2e)', () => {
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

  async function arrangePlatformOwner(label: string) {
    const owner = await signUpAndSignIn(app, label);
    await makePlatformOwner(admin, owner.userId);
    return owner;
  }

  // --- Authorization --------------------------------------------------

  describe('Authorization', () => {
    const routes = [
      '/platform-metrics',
      '/analytics/overview',
      '/analytics/time-series/users',
      '/analytics/breakdown/plan',
    ];

    it('A1: a Platform Owner can reach every P16 route', async () => {
      const owner = await arrangePlatformOwner('p16-authz-po');
      for (const route of routes) {
        await request(app.getHttpServer())
          .get(route)
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .expect(200);
      }
    });

    it('A2: a non-Platform-Owner is refused on every P16 route', async () => {
      const tenant = await signUpAndSignIn(app, 'p16-authz-tenant');
      for (const route of routes) {
        await request(app.getHttpServer())
          .get(route)
          .set('Authorization', `Bearer ${tenant.accessToken}`)
          .expect(403);
      }
    });

    it('A3: an unauthenticated caller is refused on every P16 route', async () => {
      for (const route of routes) {
        await request(app.getHttpServer()).get(route).expect(401);
      }
    });
  });

  // --- Platform Metrics (singleton) ------------------------------------

  describe('Platform Metrics', () => {
    it('B1: returns the exact seven-KPI singleton shape, all values real numbers', async () => {
      const owner = await arrangePlatformOwner('p16-metrics-po');
      const res = await request(app.getHttpServer())
        .get('/platform-metrics')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      expect(res.body).toMatchObject({
        totalAcademies: { value: expect.any(Number) },
        totalUsers: { value: expect.any(Number) },
        activeCourses: { value: expect.any(Number) },
        revenue: { amount: expect.any(Number), currency: expect.any(String) },
        systemHealthPercent: expect.any(Number),
        storageUsagePercent: expect.any(Number),
        apiUptimePercent: expect.any(Number),
        generatedAt: expect.any(String),
      });
      expect(res.body.systemHealthPercent).toBeGreaterThanOrEqual(0);
      expect(res.body.systemHealthPercent).toBeLessThanOrEqual(100);
      expect(res.body.storageUsagePercent).toBeGreaterThanOrEqual(0);
      expect(res.body.storageUsagePercent).toBeLessThanOrEqual(100);
      expect(Number.isNaN(res.body.revenue.amount)).toBe(false);
    });
  });

  // --- Date filtering / zero-denominator safety ------------------------

  describe('Date filtering', () => {
    it('C1: a genuinely empty historical period returns valid zeros, not an error', async () => {
      const owner = await arrangePlatformOwner('p16-empty-po');
      const res = await request(app.getHttpServer())
        .get('/analytics/overview')
        .query({ from: '2019-01-01', to: '2019-01-07' })
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      expect(res.body.totalUsers.value).toBe(0);
      expect(res.body.activeUsers.value).toBe(0);
      expect(res.body.engagementRatePercent).toBe(0);
      expect(res.body.revenue.value).toBe(0);
      // Both current and previous period are 0 — no meaningful change.
      expect(res.body.totalUsers.changePercent).toBeUndefined();
      expect(res.body.engagementRateChangePercent).toBeUndefined();
    });

    it('C2: time-series returns one point per day in the requested range, in order', async () => {
      const owner = await arrangePlatformOwner('p16-series-po');
      const res = await request(app.getHttpServer())
        .get('/analytics/time-series/revenue')
        .query({ from: '2026-08-01', to: '2026-08-05' })
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      expect(res.body.metric).toBe('revenue');
      expect(res.body.points).toHaveLength(5);
      expect(res.body.points.map((p: { date: string }) => p.date)).toEqual([
        '2026-08-01',
        '2026-08-02',
        '2026-08-03',
        '2026-08-04',
        '2026-08-05',
      ]);
    });

    it('C3: rejects an invalid date range (from after to)', async () => {
      const owner = await arrangePlatformOwner('p16-invalid-po');
      await request(app.getHttpServer())
        .get('/analytics/overview')
        .query({ from: '2026-08-20', to: '2026-08-01' })
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(400);
    });

    it('C4: rejects a malformed date string', async () => {
      const owner = await arrangePlatformOwner('p16-malformed-po');
      await request(app.getHttpServer())
        .get('/analytics/overview')
        .query({ from: 'not-a-date', to: '2026-08-01' })
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(400);
    });

    it('C5: an unsupported time-series metric 404s rather than fabricating data', async () => {
      const owner = await arrangePlatformOwner('p16-unsupported-metric-po');
      await request(app.getHttpServer())
        .get('/analytics/time-series/not-a-real-metric')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(404);
    });

    it('C6: an unsupported breakdown dimension 404s rather than fabricating data', async () => {
      const owner = await arrangePlatformOwner('p16-unsupported-dimension-po');
      await request(app.getHttpServer())
        .get('/analytics/breakdown/not-a-real-dimension')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(404);
    });
  });

  // --- Financial correctness -------------------------------------------

  /**
   * These endpoints are platform-WIDE (no `organizationId` filter exists
   * in the real frontend contract), and this suite runs against the
   * shared dev database more than once (project convention — the full
   * e2e suite is run twice). A fixed calendar window would silently
   * accumulate fixture data across repeated runs and make an exact
   * assertion flaky. Each financial test instead picks its own
   * pseudo-random 3-day window (independent per test, collision
   * probability negligible) so it observes ONLY the rows it itself seeds.
   */
  function randomIsolatedWindow(): { from: string; to: string; windowDate: Date } {
    const dayOffset = 100 + Math.floor(Math.random() * 9000);
    const windowDate = new Date(Date.now() - dayOffset * 24 * 60 * 60 * 1000);
    windowDate.setUTCHours(12, 0, 0, 0);
    const from = new Date(windowDate.getTime() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const to = new Date(windowDate.getTime() + 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    return { from, to, windowDate };
  }

  describe('Financial correctness', () => {
    it('D1: revenue combines subscription-billing + net course-commerce commission, excludes failed payments, and nets refunded commission to zero', async () => {
      const { from, to, windowDate } = randomIsolatedWindow();
      const owner = await arrangePlatformOwner('p16-revenue-po');
      const tenantOwner = await signUpAndSignIn(app, 'p16-revenue-tenant');
      const student = await signUpAndSignIn(app, 'p16-revenue-student');

      const org = await seedOrganizationWithOwner(
        admin,
        tenantOwner.userId,
        'p16-revenue-org',
      );
      const plan = await seedPlan(admin, 'p16-revenue-plan');
      await seedTenantSubscription(admin, org.id, plan.id, { status: 'active' });
      const academy = await seedAcademy(admin, org.id, 'p16-revenue-academy');
      const course = await seedCourse(admin, academy.id, 'p16-revenue-course', {
        status: 'published',
      });

      // 1. Atlas Subscription Billing — $100.00 succeeded.
      await seedPayment(admin, {
        organizationId: org.id,
        amountMinorUnits: 10000n,
        status: 'succeeded',
        createdAt: windowDate,
      });

      // 2. A FAILED payment for a much larger amount — must NOT be counted.
      await seedPayment(admin, {
        organizationId: org.id,
        amountMinorUnits: 999999n,
        status: 'failed',
        createdAt: windowDate,
      });

      // 3. Course Commerce — a $50.00 sale, 10% commission ($5.00 net for Atlas).
      const order1 = await seedCourseOrder(
        admin,
        student.userId,
        course.id,
        academy.id,
        org.id,
      );
      await seedRevenueLedgerEntry(admin, academy.id, order1.id, {
        entryType: 'sale',
        amountMinorUnits: 5000n,
        occurredAt: windowDate,
      });
      await seedRevenueLedgerEntry(admin, academy.id, order1.id, {
        entryType: 'platform_fee',
        amountMinorUnits: -500n,
        occurredAt: windowDate,
      });

      // 4. A SECOND course sale that was fully refunded — its commission
      // must net to exactly zero, not leak into the total.
      const order2 = await seedCourseOrder(
        admin,
        student.userId,
        course.id,
        academy.id,
        org.id,
      );
      await seedRevenueLedgerEntry(admin, academy.id, order2.id, {
        entryType: 'sale',
        amountMinorUnits: 2000n,
        occurredAt: windowDate,
      });
      await seedRevenueLedgerEntry(admin, academy.id, order2.id, {
        entryType: 'platform_fee',
        amountMinorUnits: -200n,
        occurredAt: windowDate,
      });
      await seedRevenueLedgerEntry(admin, academy.id, order2.id, {
        entryType: 'refund',
        amountMinorUnits: -2000n,
        occurredAt: windowDate,
      });
      await seedRevenueLedgerEntry(admin, academy.id, order2.id, {
        entryType: 'commission_reversal',
        amountMinorUnits: 200n,
        occurredAt: windowDate,
      });

      const res = await request(app.getHttpServer())
        .get('/analytics/overview')
        .query({ from, to })
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      // $100.00 subscription + $5.00 net commission (order1) + $0.00 (order2, fully refunded) = $105.00.
      expect(res.body.revenue.value).toBeCloseTo(105, 5);
      expect(res.body.revenueCurrency).toBe('USD');
    });

    it('D2: the "plan" breakdown reflects only subscription revenue for the paying organization’s current plan', async () => {
      const { from, to, windowDate } = randomIsolatedWindow();
      const owner = await arrangePlatformOwner('p16-breakdown-po');
      const tenantOwner = await signUpAndSignIn(app, 'p16-breakdown-tenant');
      const org = await seedOrganizationWithOwner(
        admin,
        tenantOwner.userId,
        'p16-breakdown-org',
      );
      const plan = await seedPlan(admin, 'p16-breakdown-plan');
      await seedTenantSubscription(admin, org.id, plan.id, { status: 'active' });

      await seedPayment(admin, {
        organizationId: org.id,
        amountMinorUnits: 15000n, // $150.00
        status: 'succeeded',
        createdAt: windowDate,
      });

      const res = await request(app.getHttpServer())
        .get('/analytics/breakdown/plan')
        .query({ from, to })
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      expect(res.body.dimension).toBe('plan');
      const item = res.body.items.find((i: { label: string }) => i.label === plan.name);
      expect(item).toBeDefined();
      expect(item.value).toBe(150);
    });
  });
});
