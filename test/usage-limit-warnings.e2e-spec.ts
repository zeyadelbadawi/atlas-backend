/**
 * B0-BIL-13 — after a usage recompute the organization owner is told about
 * a plan limit at 80 % or more, and about one that is reached, once per
 * limit and billing period. Runs the real recompute + warning against a
 * seeded plan (the BullMQ processor calls exactly these two).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedCourse,
  seedOrganizationWithOwner,
  seedPlan,
  seedTenantSubscription,
} from './utils/db-admin';
import { TenantUsageRecomputeService } from '../src/plans/services/tenant-usage-recompute.service';
import { UsageLimitWarningService } from '../src/plans/services/usage-limit-warning.service';

jest.setTimeout(30000);

describe('Plan limit warnings (e2e) — B0-BIL-13', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  it('warns the owner about an approaching and a reached limit, once per period', async () => {
    const email = uniqueTestEmail('bil13-owner');
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Owner', email, password: 'correct-horse-battery' })
      .expect(201);
    const owner = await admin.user.findUniqueOrThrow({ where: { email } });
    const org = await seedOrganizationWithOwner(admin, owner.id, 'bil13-org');
    const plan = await seedPlan(admin, 'bil13-plan', {
      limits: {
        academies: 1,
        students: 100,
        instructors: 5,
        staff: 5,
        courses: 5,
        generalStorage: 10,
        videoStorage: 10,
      },
    });
    await seedTenantSubscription(admin, org.id, plan.id, { status: 'active' });
    const academy = await seedAcademy(admin, org.id, 'bil13-academy');
    for (let i = 0; i < 4; i += 1) {
      await seedCourse(admin, academy.id, `bil13 course ${i}`);
    }

    const recompute = app.get(TenantUsageRecomputeService, { strict: false });
    const warnings = app.get(UsageLimitWarningService, { strict: false });
    const run = async () => {
      await recompute.recomputeOne(org.id);
      await warnings.checkAndNotify(org.id);
    };
    await run();
    await run(); // the same period never warns twice

    const rows = await admin.$queryRaw<
      { key: string; recipient_user_id: string; values: Record<string, unknown> }[]
    >`
      SELECT "key", "recipient_user_id", "values" FROM "communication_outbox"
      WHERE "organization_id" = ${org.id} AND "key" LIKE 'billing.limit.%'
      ORDER BY "key"`;
    expect(rows.map((row) => [row.key, row.values.limitKey])).toEqual([
      ['billing.limit.approaching', 'courses'],
      ['billing.limit.reached', 'academies'],
    ]);
    for (const row of rows) expect(row.recipient_user_id).toBe(owner.id);
    expect(rows[0].values).toMatchObject({ used: '4', limit: '5' });

    const feed = await admin.notification.findMany({
      where: {
        userId: owner.id,
        titleKey: { startsWith: 'notifications:events.billingLimit' },
      },
      select: { titleKey: true, actionUrl: true, context: true },
      orderBy: { titleKey: 'asc' },
    });
    expect(feed).toEqual([
      {
        titleKey: 'notifications:events.billingLimitApproachingCourses.title',
        actionUrl: '/dashboard/plans',
        context: 'management',
      },
      {
        titleKey: 'notifications:events.billingLimitReachedAcademies.title',
        actionUrl: '/dashboard/plans',
        context: 'management',
      },
    ]);
  });
});
