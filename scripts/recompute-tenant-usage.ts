/**
 * Manual/ops trigger for `TenantUsageRecomputeService.recomputeOne` — the
 * real, working per-organization entrypoint this phase ships in place of
 * a platform-wide scheduled sweep (see `TenantUsageRecomputeService`'s doc
 * comment for why a full-platform sweep is out of P4's scope). Useful for:
 *   - manual/ops recomputation of one organization's usage on demand;
 *   - the P4 manual test runbook, so a tester can make usage data appear
 *     without waiting on a not-yet-built scheduler.
 *
 * Usage: `npm run worker:recompute-usage -- <organizationId>`
 *
 * Boots a real, full Nest application context (real Postgres/Redis
 * connections, real `atlas_app` runtime role, real RLS) — not a mock, not
 * a raw SQL shortcut. Exits non-zero on any failure so it's safe to use in
 * an ops runbook or a cron entry later.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { TenantUsageRecomputeService } from '../src/plans/services/tenant-usage-recompute.service';

async function main(): Promise<void> {
  const organizationId = process.argv[2];
  if (!organizationId) {
    // eslint-disable-next-line no-console
    console.error('Usage: npm run worker:recompute-usage -- <organizationId>');
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const recomputeService = app.get(TenantUsageRecomputeService);
    await recomputeService.recomputeOne(organizationId);
    // eslint-disable-next-line no-console
    console.log(`Recomputed tenant_usage for organization ${organizationId}.`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Recompute failed:', error);
  process.exit(1);
});
