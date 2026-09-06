/**
 * One-off (but safely re-runnable) maintenance script — reduces the
 * shared `plans` catalog to exactly the 3 real, production plans
 * `prisma/seed.ts` defines (`starter`/`growth`/`enterprise`), removing
 * every e2e-test-fixture row.
 *
 * Background (checkout/plans investigation): `plans` has NO write
 * endpoint at all — the only two ways a `Plan` row is ever created are
 * `prisma/seed.ts`'s `seedPlansAndSubscriptions` (upserts exactly the 3
 * real plans, by their stable `key`) and raw test fixtures
 * (`test/utils/db-admin.ts`'s `seedPlan`, and a handful of e2e specs'
 * own direct `admin.plan.create(...)` calls). This means ANY plan whose
 * `key` is not one of the 3 real ones is, with total certainty, a test
 * fixture — never ambiguous, never a real customer's configuration.
 *
 * `PlansRepository`'s `CUSTOMER_FACING_WHERE` filter (the code fix this
 * script accompanies) already keeps every such fixture out of `GET
 * /plans` and out of the default-trial-plan lookup permanently, going
 * forward, regardless of how many more fixture rows accumulate — so this
 * script is a ROW-COUNT hygiene tool, not what makes the catalog correct.
 * Run it periodically (or add it to a scheduled maintenance job) to keep
 * the table itself small, never as a prerequisite for correctness.
 *
 * Deletion order respects the real FK shape (`schema.prisma`):
 *   1. `tenant_subscriptions` — `Plan.subscriptions` has no `onDelete`
 *      (defaults to RESTRICT), so a plan with a live subscription cannot
 *      be deleted until its subscription rows are gone first. Every such
 *      subscription belongs to an organization that itself only exists
 *      because some test created it alongside this exact fixture plan —
 *      deleting it is the same "test fixture, not real data" fact the
 *      plan itself already established, not a separate judgment call.
 *   2. `plans` — `PlanCommissionSettings` cascades automatically
 *      (`onDelete: Cascade`), so no separate step is needed for it.
 *
 * `Checkout.targetKey` stores the plan key as a plain string, not a real
 * foreign key (`Checkout.snapshot` is frozen at creation time — see that
 * model's own doc comment) — deleting a Plan never blocks on a Checkout
 * row, and never needs to touch one.
 *
 * Usage: `npm run db:cleanup-plan-catalog` (dry run: pass `--dry-run`).
 */
import { PrismaClient } from '@prisma/client';

const REAL_PLAN_KEYS = ['starter', 'growth', 'enterprise'] as const;

function requireAdminDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL must be set (the same superuser connection Prisma migrations use).');
  }
  return url;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const prisma = new PrismaClient({ datasources: { db: { url: requireAdminDatabaseUrl() } } });

  try {
    const before = await prisma.plan.count();
    const toRemove = await prisma.plan.findMany({
      where: { key: { notIn: [...REAL_PLAN_KEYS] } },
      select: { id: true, key: true },
    });

    console.log(`Plans in catalog: ${before}`);
    console.log(`Real, kept plans: ${REAL_PLAN_KEYS.join(', ')}`);
    console.log(`Fixture plans to remove: ${toRemove.length}`);

    if (toRemove.length === 0) {
      console.log('Nothing to clean up — catalog already holds only the real plans.');
      return;
    }

    if (dryRun) {
      console.log('Dry run — no rows were deleted. Re-run without --dry-run to apply.');
      return;
    }

    const removeIds = toRemove.map((plan) => plan.id);

    const { count: subscriptionsRemoved } = await prisma.tenantSubscription.deleteMany({
      where: { planId: { in: removeIds } },
    });
    console.log(`Deleted ${subscriptionsRemoved} fixture tenant_subscriptions row(s) referencing removed plans.`);

    const { count: plansRemoved } = await prisma.plan.deleteMany({
      where: { id: { in: removeIds } },
    });
    console.log(`Deleted ${plansRemoved} fixture plan row(s).`);

    const after = await prisma.plan.count();
    console.log(`Plans in catalog now: ${after}`);
    if (after !== REAL_PLAN_KEYS.length) {
      throw new Error(
        `Expected exactly ${REAL_PLAN_KEYS.length} plans after cleanup, found ${after}.`,
      );
    }
    console.log('✔ Plan catalog now holds exactly the 3 real, customer-facing plans.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Plan catalog cleanup failed:', error);
  process.exit(1);
});
