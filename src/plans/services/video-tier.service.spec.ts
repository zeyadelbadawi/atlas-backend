/**
 * `VideoTierService.entitledTier` — the CEILING half of the chain
 * (P64 Phase 2 — D10, D11, AD-15).
 *
 * WHAT THIS PROTECTS. `entitledTier` is the single place that turns "what
 * did this customer buy" into "may their uploads be Premium". Everything
 * downstream — the academy's stored preference, `assertEntitled`'s 403,
 * the provider registry's adapter choice — is bounded by its answer, so
 * the two ways it can be wrong are both product failures:
 *
 *   - granting `premium` to a Normal customer gives away a capability
 *     with a real external cost that nobody paid for;
 *   - and the dangerous variant of that is the ABSENT subscription. A
 *     lookup that returns nothing must resolve to `normal`, never to the
 *     higher tier: an entitlement nobody can prove was purchased must not
 *     be granted by a missing row.
 *
 * The family is read from the plan row and NOWHERE ELSE. No plan key is
 * parsed and no provider class is named — D10 forbids `premium` being
 * hard-wired to `CloudflareStreamProvider` anywhere in the authorization
 * layer, and this service is that layer.
 *
 * Unit tests, no database: `entitledTier` is a pure decision over one
 * repository read, and the `Prisma.TransactionClient` it takes is only
 * ever handed onward to that repository. The real RLS-scoped read is
 * proved against PostgreSQL in the Phase 2 e2e suite.
 */
import type { Plan, Prisma, TenantSubscription } from '@prisma/client';
import { VideoTierService } from './video-tier.service';
import { PLAN_CATALOG, PLAN_TIERS } from '../utils/plan-catalog.util';

/**
 * The transaction client, hand-written.
 *
 * Deliberately EMPTY. `entitledTier` never calls a model method on it —
 * it passes the handle straight to `TenantSubscriptionsRepository`, which
 * is where the RLS-scoped query lives. A fake with query methods on it
 * would imply this service issues queries of its own, which is exactly
 * the coupling the repository layer exists to prevent. Identity matters
 * though, so the tests assert this exact object reaches the repository.
 */
const tx = {} as Prisma.TransactionClient;

type SubscriptionWithPlan = TenantSubscription & { plan: Plan };

/**
 * A subscription row as the repository returns it — only the one field
 * the decision reads is real. Cast once, here, rather than hand-typing
 * forty irrelevant columns per case (the same `as never`/`as unknown as`
 * fixture precedent `entitlement-enforcement.service.spec.ts` established).
 */
function subscriptionOnPlan(plan: Partial<Plan>): SubscriptionWithPlan {
  return {
    organizationId: 'org-1',
    status: 'active',
    plan: { key: 'growth', family: 'normal', tier: 'growth', ...plan },
  } as unknown as SubscriptionWithPlan;
}

function buildService(subscription: SubscriptionWithPlan | null) {
  const findByOrganizationId = jest.fn().mockResolvedValue(subscription);
  const service = new VideoTierService({ findByOrganizationId } as never);
  return { service, findByOrganizationId };
}

describe('VideoTierService.entitledTier — the plan family is the ceiling (D10)', () => {
  it.each(PLAN_TIERS)(
    'returns `premium` for a premium-family plan on the %s tier',
    async (tier) => {
      const variant = PLAN_CATALOG.premium[tier];
      const { service } = buildService(
        subscriptionOnPlan({ key: variant.key, family: 'premium', tier }),
      );

      await expect(service.entitledTier(tx, 'org-1')).resolves.toBe('premium');
    },
  );

  it.each(PLAN_TIERS)(
    'returns `normal` for a normal-family plan on the %s tier',
    async (tier) => {
      // The TIER never grants the capability. A Normal Enterprise
      // customer buys unlimited seats, not Premium video — that is the
      // whole reason family and tier are two columns (D10).
      const variant = PLAN_CATALOG.normal[tier];
      const { service } = buildService(
        subscriptionOnPlan({ key: variant.key, family: 'normal', tier }),
      );

      await expect(service.entitledTier(tx, 'org-1')).resolves.toBe('normal');
    },
  );

  it('returns `normal` when the organization has NO subscription at all', () => {
    // The failure direction that matters: an entitlement nobody can prove
    // was purchased must never be granted by a missing row.
    const { service } = buildService(null);

    return expect(service.entitledTier(tx, 'org-1')).resolves.toBe('normal');
  });

  it('returns `normal` for a plan row whose family is missing entirely', async () => {
    // A row written before the Phase 2 columns existed, or by a test
    // fixture that never set them. Absent is not `premium`.
    const { service } = buildService(subscriptionOnPlan({ family: undefined }));

    await expect(service.entitledTier(tx, 'org-1')).resolves.toBe('normal');
  });

  it('never infers the family from the plan key', async () => {
    // A key that merely LOOKS premium grants nothing. The column is the
    // only authority — inferring from the key would be the hard-wiring
    // D10 forbids, moved into a string comparison.
    const { service } = buildService(
      subscriptionOnPlan({ key: 'premium-growth', family: 'normal', tier: 'growth' }),
    );

    await expect(service.entitledTier(tx, 'org-1')).resolves.toBe('normal');
  });

  it('reads the subscription through the transaction client it was given', async () => {
    // The handle carries the RLS tenant context. Resolving an entitlement
    // outside it would read another tenant's row, or none.
    const { service, findByOrganizationId } = buildService(
      subscriptionOnPlan({ family: 'premium', tier: 'basic' }),
    );

    await service.entitledTier(tx, 'org-42');

    expect(findByOrganizationId).toHaveBeenCalledWith(tx, 'org-42');
  });
});
