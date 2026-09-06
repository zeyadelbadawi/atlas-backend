/**
 * TenantUsageSweepCursorRepository — real Postgres e2e (Phase 4.6 fix).
 * Proves the actual persistence primitive `SubscriptionSweepService` now
 * relies on to survive across ticks/restarts/backend instances is real
 * and correct against the real database: a fixed-id singleton row,
 * read/written via `upsert`, never a find-then-create pair.
 *
 * `subscription-sweep.service.spec.ts` covers the cursor-progression
 * CONTROL FLOW that consumes this primitive, with mocks — deliberately,
 * see that file's own header for why (this dev database also holds the
 * large synthetic dataset Phase 4.6's dedicated 100K-scale re-validation
 * needs to stay genuinely stale until that dedicated benchmark runs).
 * This file touches only the brand-new, otherwise-empty
 * `tenant_usage_sweep_cursor` table — completely disjoint from
 * `organizations` — so it carries no such risk.
 */
import { INestApplication } from '@nestjs/common';
import { createTestApp } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import { TenantUsageSweepCursorRepository } from '../src/plans/repositories/tenant-usage-sweep-cursor.repository';
import { PrismaService } from '../src/database/prisma.service';
import type { PrismaClient } from '@prisma/client';

describe('TenantUsageSweepCursorRepository (e2e) — real Postgres', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let repository: TenantUsageSweepCursorRepository;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    repository = app.get(TenantUsageSweepCursorRepository, { strict: false });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  it('write then read round-trips the exact value written', async () => {
    await repository.write('p46-org-000042');
    expect(await repository.read()).toBe('p46-org-000042');

    await repository.write('some-other-org-id');
    expect(await repository.read()).toBe('some-other-org-id');
  });

  it('writing null explicitly resets to "start from the beginning" (read returns undefined, not the string "null")', async () => {
    await repository.write('an-org-id');
    expect(await repository.read()).toBe('an-org-id');

    await repository.write(null);
    expect(await repository.read()).toBeUndefined();
  });

  it('upsert never creates a second row — exactly one singleton row exists no matter how many times it is written', async () => {
    await repository.write('first-write');
    await repository.write('second-write');
    await repository.write('third-write');

    const rows = await admin.tenantUsageSweepCursor.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].lastOrganizationId).toBe('third-write');
  });

  it('concurrent writes race-safely converge to a single row — no duplicate-key crash, no lost row', async () => {
    // Simulates two backend instances' sweep workers both persisting
    // progress at close to the same time under BullMQ horizontal scaling
    // — exactly the race `upsert`-on-a-fixed-id (never find-then-create)
    // exists to close atomically at the database level.
    await Promise.all([
      repository.write('race-a'),
      repository.write('race-b'),
      repository.write('race-c'),
    ]);
    const rows = await admin.tenantUsageSweepCursor.findMany();
    expect(rows).toHaveLength(1);
    expect(['race-a', 'race-b', 'race-c']).toContain(rows[0].lastOrganizationId);
  });

  it('survives being read by a brand-new repository instance — proves this is real persisted state, not in-memory', async () => {
    await repository.write('persisted-across-instances');

    const freshRepository = new TenantUsageSweepCursorRepository(
      app.get(PrismaService, { strict: false }),
    );
    expect(await freshRepository.read()).toBe('persisted-across-instances');
  });
});
