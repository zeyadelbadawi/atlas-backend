/**
 * Plan management (item 9) — new organizations get the first listed plan
 * as their placeholder and signup offers only listed plans, so archiving
 * or hiding the LAST listed plan is refused (409 errors.plan.lastListedPlan).
 * The e2e suite cannot reach this state without unlisting the real
 * catalog, so it is pinned here against a mocked transaction.
 */
import { ConflictException } from '@nestjs/common';
import { PlatformPlansService } from './platform-plans.service';

const listedPlan = {
  id: 'plan-1',
  key: 'starter',
  name: 'Starter',
  status: 'active',
  displayOrder: 1,
  version: 4,
  limits: {},
  features: {},
  pricing: null,
};

function serviceWith(otherListedPlans: number) {
  const tx = {
    plan: {
      findUnique: jest.fn().mockResolvedValue(listedPlan),
      count: jest.fn().mockResolvedValue(otherListedPlans),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ ...listedPlan, status: 'archived' }),
    },
  };
  const run = (_id: string, work: (t: unknown) => unknown) => work(tx);
  const service = new PlatformPlansService(
    { $transaction: (work: (t: unknown) => unknown) => work(tx) } as never,
    { runInUserContext: run } as never,
    { write: jest.fn() } as never,
    {} as never,
    {
      countOne: jest
        .fn()
        .mockResolvedValue({ paying: 0, trialing: 0, scheduledIn: 0, foundingLocks: 0 }),
    } as never,
    {} as never,
  );
  return { service, tx };
}

describe('PlatformPlansService — the last listed plan', () => {
  it('refuses to archive the last listed plan, before writing anything', async () => {
    const { service, tx } = serviceWith(0);
    const refusal = service.archive('po-1', 'starter', { expectedVersion: 4 });
    await expect(refusal).rejects.toBeInstanceOf(ConflictException);
    await expect(refusal).rejects.toMatchObject({
      response: { messageKey: 'errors.plan.lastListedPlan' },
    });
    expect(tx.plan.updateMany).not.toHaveBeenCalled();
  });

  it('archives a listed plan when another one is still listed', async () => {
    const { service, tx } = serviceWith(2);
    await service.archive('po-1', 'starter', { expectedVersion: 4 });
    expect(tx.plan.updateMany).toHaveBeenCalled();
  });

  it('refuses to hide the last listed plan through an edit', async () => {
    const { service } = serviceWith(0);
    await expect(
      service.update('po-1', 'starter', { expectedVersion: 4, displayOrder: 0 } as never),
    ).rejects.toMatchObject({ response: { messageKey: 'errors.plan.lastListedPlan' } });
  });
});
