/**
 * One-off (but safely re-runnable) maintenance script — removes e2e
 * test-fixture rows from the shared `plans` catalog, keeping the
 * catalog-defined plans (`src/plans/utils/plan-catalog.util.ts`) and every
 * plan that is real for another reason (see "Background" below).
 *
 * P64 Phase 2 (D10): that catalog is now SIX variants, not three —
 * `starter`/`growth`/`enterprise` (Normal) plus `premium-starter`/
 * `premium-growth`/`premium-enterprise`. The real keys are imported from
 * the one table the seed and the premium-plan migration also write from,
 * rather than restated here: a literal list in this file that fell behind
 * the catalog would not merely be stale, it would DELETE real plans and
 * every subscription referencing them.
 *
 * A plan is NOT necessarily a fixture just because its key is not a
 * catalog key: since the Platform Owner console gained "New plan"
 * (`POST /platform-plans`), real plans can have any key. Deleting one
 * would delete its customers' subscriptions with it. So a plan is kept
 * when it is a catalog plan, was created through the console (a
 * `plan.created` audit entry names it), belongs to an organization that
 * has ever paid, or holds a Founding Academy lock
 * (`src/plans/utils/plan-cleanup.util.ts`). Only the rest are fixtures.
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
import { PLAN_CATALOG_KEYS } from '../src/plans/utils/plan-catalog.util';
import { selectRemovablePlans } from '../src/plans/utils/plan-cleanup.util';

const REAL_PLAN_KEYS: readonly string[] = PLAN_CATALOG_KEYS;

function requireAdminDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL must be set (the same superuser connection Prisma migrations use).',
    );
  }
  return url;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const prisma = new PrismaClient({
    datasources: { db: { url: requireAdminDatabaseUrl() } },
  });

  try {
    const before = await prisma.plan.count();
    const plans = await prisma.plan.findMany({ select: { id: true, key: true } });

    const created = await prisma.auditLogEntry.findMany({
      where: { action: 'plan.created', targetType: 'plan' },
      select: { targetId: true },
    });
    const paid = await prisma.$queryRaw<{ plan_id: string }[]>`
      SELECT DISTINCT ts.plan_id
      FROM tenant_subscriptions ts
      WHERE EXISTS (SELECT 1 FROM payments p WHERE p.organization_id = ts.organization_id)`;
    const founding = await prisma.foundingMembership.findMany({
      select: { planId: true },
      distinct: ['planId'],
    });

    const { remove: toRemove, keep } = selectRemovablePlans(plans, REAL_PLAN_KEYS, {
      consoleCreatedPlanIds: new Set(created.map((row) => row.targetId)),
      planIdsWithPayments: new Set(paid.map((row) => row.plan_id)),
      planIdsWithFoundingMemberships: new Set(founding.map((row) => row.planId)),
    });

    console.log(`Plans in catalog: ${before}`);
    console.log(`Catalog plans: ${REAL_PLAN_KEYS.join(', ')}`);
    for (const { plan, reason } of keep) {
      if (reason !== 'catalog') console.log(`Kept (${reason}): ${plan.key}`);
    }
    console.log(`Fixture plans to remove: ${toRemove.length}`);

    if (toRemove.length === 0) {
      console.log('Nothing to clean up: the catalog holds no fixture plans.');
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
    console.log(
      `Deleted ${subscriptionsRemoved} fixture tenant_subscriptions row(s) referencing removed plans.`,
    );

    const { count: plansRemoved } = await prisma.plan.deleteMany({
      where: { id: { in: removeIds } },
    });
    console.log(`Deleted ${plansRemoved} fixture plan row(s).`);

    const after = await prisma.plan.count();
    console.log(`Plans in catalog now: ${after}`);
    if (after !== keep.length) {
      throw new Error(`Expected ${keep.length} plans after cleanup, found ${after}.`);
    }
    console.log(`✔ Plan catalog now holds only the ${keep.length} kept plan(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Plan catalog cleanup failed:', error);
  process.exit(1);
});
