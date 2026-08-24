/**
 * `tenant-usage-recompute` worker — real BullMQ/Redis transport e2e
 * (master plan §12/§21 Phase P4). `tenant-subscription.e2e-spec.ts`
 * already proves the recomputation LOGIC directly against
 * `TenantUsageRecomputeService`; this file proves the QUEUE half: a job
 * enqueued via `TenantUsageRecomputeProducer` is actually picked up and
 * processed by the real `TenantUsageRecomputeProcessor`/BullMQ worker,
 * and that redelivering the same job is safe (idempotent).
 */
import { INestApplication } from '@nestjs/common';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedOrganizationWithOwner,
  seedPlan,
  seedTenantSubscription,
} from './utils/db-admin';
import { createTestApp, waitForAsync } from './utils/test-app';
import { TenantUsageRecomputeProducer } from '../src/plans/queue/tenant-usage-recompute.producer';
import type { PrismaClient } from '@prisma/client';

describe('tenant-usage-recompute worker (e2e) — real BullMQ/Redis', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let producer: TenantUsageRecomputeProducer;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    producer = app.get(TenantUsageRecomputeProducer, { strict: false });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  it('an enqueued job is processed by the real worker and produces real usage data', async () => {
    const owner = await admin.user.create({
      data: {
        email: `worker-owner-${Date.now()}@test.local`,
        passwordHash: 'x',
        name: 'Worker Owner',
      },
    });
    const org = await seedOrganizationWithOwner(admin, owner.id, 'worker-org');
    const plan = await seedPlan(admin, 'worker-plan');
    await seedTenantSubscription(admin, org.id, plan.id);
    const academy = await seedAcademy(admin, org.id, 'worker-academy');
    await seedAcademyMember(admin, academy.id, owner.id, 'owner');

    await producer.enqueueOne(org.id);

    const usage = await waitForAsync(
      () => {
        return admin.tenantUsage
          .findUnique({ where: { organizationId: org.id } })
          .then((row) => row ?? undefined);
      },
      { timeoutMs: 10000 },
    );

    expect(usage.academies).toBe(1);
  });

  it('redelivering the same job (simulated by enqueuing twice) is idempotent', async () => {
    const owner = await admin.user.create({
      data: {
        email: `worker-redelivery-${Date.now()}@test.local`,
        passwordHash: 'x',
        name: 'Redelivery Owner',
      },
    });
    const org = await seedOrganizationWithOwner(admin, owner.id, 'worker-redelivery-org');
    const plan = await seedPlan(admin, 'worker-redelivery-plan');
    await seedTenantSubscription(admin, org.id, plan.id);
    const academy = await seedAcademy(admin, org.id, 'worker-redelivery-academy');
    await seedAcademyMember(admin, academy.id, owner.id, 'owner');

    await producer.enqueueOne(org.id);
    const first = await waitForAsync(
      () =>
        admin.tenantUsage
          .findUnique({ where: { organizationId: org.id } })
          .then((row) => row ?? undefined),
      { timeoutMs: 10000 },
    );

    // Simulate redelivery: a second job for the same organization, run
    // after the first has already completed and been recorded.
    const beforeSecondEnqueue = first.updatedAt.getTime();
    await producer.enqueueOne(org.id);
    const second = await waitForAsync(
      () => {
        return admin.tenantUsage
          .findUnique({ where: { organizationId: org.id } })
          .then((row) => {
            if (!row || row.updatedAt.getTime() <= beforeSecondEnqueue) return undefined;
            return row;
          });
      },
      { timeoutMs: 10000 },
    );

    expect(second.academies).toBe(first.academies);
    expect(second.instructors).toBe(first.instructors);
    expect(second.staff).toBe(first.staff);
  });

  it('enqueuing jobs for two different organizations never cross-contaminates their usage', async () => {
    const ownerA = await admin.user.create({
      data: {
        email: `worker-multiA-${Date.now()}@test.local`,
        passwordHash: 'x',
        name: 'Multi Owner A',
      },
    });
    const ownerB = await admin.user.create({
      data: {
        email: `worker-multiB-${Date.now()}@test.local`,
        passwordHash: 'x',
        name: 'Multi Owner B',
      },
    });
    const orgA = await seedOrganizationWithOwner(admin, ownerA.id, 'worker-multi-orgA');
    const orgB = await seedOrganizationWithOwner(admin, ownerB.id, 'worker-multi-orgB');
    const planA = await seedPlan(admin, 'worker-multi-planA');
    const planB = await seedPlan(admin, 'worker-multi-planB');
    await seedTenantSubscription(admin, orgA.id, planA.id);
    await seedTenantSubscription(admin, orgB.id, planB.id);
    const academyA = await seedAcademy(admin, orgA.id, 'worker-multi-a');
    await seedAcademyMember(admin, academyA.id, ownerA.id, 'owner');

    await producer.enqueueOne(orgA.id);
    await producer.enqueueOne(orgB.id);

    const usageA = await waitForAsync(
      () =>
        admin.tenantUsage
          .findUnique({ where: { organizationId: orgA.id } })
          .then((row) => row ?? undefined),
      { timeoutMs: 10000 },
    );
    const usageB = await waitForAsync(
      () =>
        admin.tenantUsage
          .findUnique({ where: { organizationId: orgB.id } })
          .then((row) => row ?? undefined),
      { timeoutMs: 10000 },
    );

    expect(usageA.academies).toBe(1);
    expect(usageB.academies).toBe(0);
  });
});
