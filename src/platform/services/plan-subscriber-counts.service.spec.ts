import { PlanSubscriberCountsService } from './plan-subscriber-counts.service';

describe('PlanSubscriberCountsService', () => {
  const now = new Date('2026-11-07T10:00:00Z');

  it('groups paying, trialing, switching-in and founding counts per plan, in the owner context', async () => {
    const groupBy = jest
      .fn()
      .mockResolvedValueOnce([{ planId: 'p1', _count: { _all: 3 } }])
      .mockResolvedValueOnce([{ planId: 'p1', _count: { _all: 2 } }])
      .mockResolvedValueOnce([{ scheduledPlanId: 'p2', _count: { _all: 1 } }]);
    const foundingGroupBy = jest
      .fn()
      .mockResolvedValue([{ planId: 'p2', _count: { _all: 4 } }]);
    const tx = {
      tenantSubscription: { groupBy },
      foundingMembership: { groupBy: foundingGroupBy },
    };
    const runInUserContext = jest.fn((_id: string, work: (t: unknown) => unknown) =>
      work(tx),
    );
    const service = new PlanSubscriberCountsService({ runInUserContext } as never);

    const counts = await service.countByPlan('po-1', ['p1', 'p2', 'p3'], now);

    expect(runInUserContext).toHaveBeenCalledWith('po-1', expect.any(Function));
    expect(counts.get('p1')).toEqual({
      paying: 3,
      trialing: 2,
      scheduledIn: 0,
      foundingLocks: 0,
    });
    expect(counts.get('p2')).toEqual({
      paying: 0,
      trialing: 0,
      scheduledIn: 1,
      foundingLocks: 4,
    });
    expect(counts.get('p3')).toEqual({
      paying: 0,
      trialing: 0,
      scheduledIn: 0,
      foundingLocks: 0,
    });

    // Paying = active, past_due, grace_period; trials only while still running.
    expect(groupBy.mock.calls[0][0].where).toEqual({
      planId: { in: ['p1', 'p2', 'p3'] },
      status: { in: ['active', 'past_due', 'grace_period'] },
    });
    expect(groupBy.mock.calls[1][0].where).toEqual({
      planId: { in: ['p1', 'p2', 'p3'] },
      status: 'trialing',
      trialEndsAt: { gt: now },
    });
    expect(groupBy.mock.calls[2][0].where).toEqual({
      scheduledPlanId: { in: ['p1', 'p2', 'p3'] },
      scheduledChangeAt: { gt: now },
    });
  });

  it('does not query anything for an empty page', async () => {
    const runInUserContext = jest.fn();
    const service = new PlanSubscriberCountsService({ runInUserContext } as never);
    await expect(service.countByPlan('po-1', [])).resolves.toEqual(new Map());
    expect(runInUserContext).not.toHaveBeenCalled();
  });
});
