import {
  planKeepReason,
  selectRemovablePlans,
  type PlanCleanupEvidence,
} from './plan-cleanup.util';

const none: PlanCleanupEvidence = {
  consoleCreatedPlanIds: new Set(),
  planIdsWithPayments: new Set(),
  planIdsWithFoundingMemberships: new Set(),
};

describe('plan cleanup selection', () => {
  const catalog = ['starter', 'growth'];

  it('keeps catalog plans, console-created plans, paid-for plans and founding locks', () => {
    const evidence: PlanCleanupEvidence = {
      consoleCreatedPlanIds: new Set(['p-console']),
      planIdsWithPayments: new Set(['p-paid']),
      planIdsWithFoundingMemberships: new Set(['p-founding']),
    };
    expect(planKeepReason({ id: 'p1', key: 'starter' }, catalog, evidence)).toBe(
      'catalog',
    );
    expect(
      planKeepReason({ id: 'p-console', key: 'teachers-plus' }, catalog, evidence),
    ).toBe('console-created');
    expect(planKeepReason({ id: 'p-paid', key: 'old-deal' }, catalog, evidence)).toBe(
      'has-payments',
    );
    expect(planKeepReason({ id: 'p-founding', key: 'lock' }, catalog, evidence)).toBe(
      'founding-lock',
    );
    expect(
      planKeepReason({ id: 'p-fixture', key: 'e2e-plan-123' }, catalog, evidence),
    ).toBeNull();
  });

  it('removes only plans with no reason to keep them', () => {
    const selection = selectRemovablePlans(
      [
        { id: 'a', key: 'starter' },
        { id: 'b', key: 'e2e-1' },
        { id: 'c', key: 'console-made' },
      ],
      catalog,
      { ...none, consoleCreatedPlanIds: new Set(['c']) },
    );
    expect(selection.remove).toEqual([{ id: 'b', key: 'e2e-1' }]);
    expect(selection.keep.map((k) => [k.plan.key, k.reason])).toEqual([
      ['starter', 'catalog'],
      ['console-made', 'console-created'],
    ]);
  });
});
