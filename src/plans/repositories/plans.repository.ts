/**
 * PlansRepository — `plans` is a PLATFORM-owned catalog table, no RLS, no
 * tenant context (see the P4 migration's doc comment). Unlike every
 * tenant-scoped repository in this codebase, this one takes the raw
 * `PrismaService` directly, not a `Prisma.TransactionClient` from
 * `TenancyContextService` — there is no tenant context to establish for a
 * table every caller reads identically.
 */
import { Injectable } from '@nestjs/common';
import type { Plan, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

/**
 * Phase "checkout/plans fix" — the real, customer-facing catalog.
 *
 * `displayOrder > 0` is the one signal, already present in the schema
 * (`@@index([status, displayOrder])` was already shaped for exactly this
 * filter, unused until now), that distinguishes a deliberately curated,
 * customer-facing Plan (`prisma/seed.ts`'s `starter`/`growth`/`enterprise`,
 * each seeded with an explicit `displayOrder: 1/2/3`) from every plan any
 * test fixture creates (`test/utils/db-admin.ts`'s `seedPlan`, and every
 * raw `admin.plan.create(...)` call across the e2e suite) — none of which
 * ever sets `displayOrder`, so it stays at its schema default of `0`.
 *
 * Root cause this closes: `plans` has no write endpoint at all (a real
 * Plan is only ever created by `prisma/seed.ts` or raw test fixtures —
 * never application code), so a `displayOrder` of exactly `0` is not a
 * legitimate "first position" — it is the unambiguous signature of a
 * fixture row. Investigated live: the shared dev database held 6,039 Plan
 * rows, 6,036 of them fixtures (`displayOrder: 0`), several thousand with
 * no `pricing` at all — and because the catalog was sorted by
 * `displayOrder ASC` with no floor, those fixtures sorted BEFORE the 3 real
 * plans (which sat at positions 6037–6039). A real customer's first click
 * was guaranteed to hit a broken, unpriced plan and fail Checkout with
 * `errors.checkout.pricingUnavailable`. This filter is the permanent fix:
 * it holds regardless of how many more fixture rows any future test run
 * accumulates, with no per-test cleanup required to stay correct.
 *
 * `status: 'active'` is kept alongside it — an intentionally archived plan
 * (real or fixture) must never resurface here either.
 */
const CUSTOMER_FACING_WHERE: Prisma.PlanWhereInput = {
  status: 'active',
  displayOrder: { gt: 0 },
};

@Injectable()
export class PlansRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<Plan[]> {
    return this.prisma.plan.findMany({
      where: CUSTOMER_FACING_WHERE,
      orderBy: { displayOrder: 'asc' },
    });
  }

  /**
   * Phase 4.5.3 (scalability, Change 4) — `findAll` above is kept
   * untouched (same "additive, not replacing" precedent as Phase 4.5.2's
   * `findStaleUsageOrganizationIds`), for any future caller that
   * genuinely needs the full catalog. `PlansService.getPlans` now calls
   * this paginated method instead: `GET /plans` returned every row
   * unpaginated, and this dev database's accumulated e2e-test fixture
   * rows (4,879 at the time of writing, confirmed via `ATLAS_
   * SCALABILITY_ARCHITECTURE_PLAN.md`/`ATLAS_SCALABILITY_PHASE_4_5_3_
   * REPORT.md`) already made the real `/dashboard/plans` page hang in a
   * real browser — reproduced independently twice, in Phase 4.5 and
   * again in Phase 4.5.1's own regression pass. A real production catalog
   * is small, but nothing should ever again require a page to render an
   * unbounded number of rows to prove that.
   *
   * Now additionally scoped to `CUSTOMER_FACING_WHERE` (see that
   * constant's own doc comment) — the real, follow-up defect Phase 4.5.3's
   * own pagination fix left open: bounding the PAGE SIZE stopped the page
   * from hanging, but every one of those thousands of fixture rows was
   * still a real, selectable, guaranteed-to-fail plan on page 1.
   *
   * `orderBy` breaks `displayOrder` ties with `createdAt`/`id`, matching
   * `findDefaultTrialPlan`'s own established precedent below — kept even
   * though the 3 real plans now have distinct `displayOrder` values with
   * no ties among them, so a future 4th real plan added with a duplicate
   * `displayOrder` still paginates deterministically.
   */
  async findManyPaginated(
    skip: number,
    take: number,
  ): Promise<{ items: Plan[]; totalItems: number }> {
    const [items, totalItems] = await Promise.all([
      this.prisma.plan.findMany({
        where: CUSTOMER_FACING_WHERE,
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        skip,
        take,
      }),
      this.prisma.plan.count({ where: CUSTOMER_FACING_WHERE }),
    ]);
    return { items, totalItems };
  }

  findByKey(key: string): Promise<Plan | null> {
    return this.prisma.plan.findUnique({ where: { key } });
  }

  findById(id: string): Promise<Plan | null> {
    return this.prisma.plan.findUnique({ where: { id } });
  }

  /**
   * Phase 2 — the trial-tier Plan a brand-new Organization's subscription
   * is created against. No dedicated "trial plan" concept exists in this
   * schema (a trial is a subscription STATUS, `'trialing'`, not a
   * separate catalog entry) — matching the pre-existing dev seed's own
   * precedent (`seed.ts`'s `orgB` trialing subscription uses the plain
   * `starter` plan), the lowest-`displayOrder` active Plan is used: the
   * smallest entry point a real self-service signup should land on,
   * exactly the one a brand-new customer would be expected to start
   * evaluating from. `createdAt` (then `id`) breaks a `displayOrder` tie
   * deterministically — a real catalog assigns each Plan a distinct
   * `displayOrder` (see `seed.ts`: 1/2/3), so this only ever matters if
   * two Plans genuinely share one, and even then always resolves to the
   * SAME Plan on every call rather than whichever row Postgres happens to
   * return first.
   */
  /**
   * Second real bug this same investigation found, beyond the manual
   * "select a plan" path: this query had no `displayOrder` floor either,
   * so `OrganizationSubscriptionBootstrapService` — which runs for EVERY
   * new organization — was resolving `precedence-plan-…` (the same
   * unpriced P13-test fixture, `displayOrder: 0`, earliest `createdAt`
   * among 6,036 identically-unordered fixture rows) as the "default trial
   * plan" for every brand-new signup, not `starter`. Confirmed live: a
   * fresh organization created during this investigation was bootstrapped
   * onto `precedence-plan-…`, not `starter`. Same `CUSTOMER_FACING_WHERE`
   * fix applies here for the identical reason.
   */
  findDefaultTrialPlan(): Promise<Plan | null> {
    return this.prisma.plan.findFirst({
      where: CUSTOMER_FACING_WHERE,
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
  }
}
