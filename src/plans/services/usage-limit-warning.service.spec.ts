import { NotFoundException } from '@nestjs/common';
import type { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import type { CommunicationService } from '../../communications/services/communication.service';
import type { TenantSubscriptionService } from './tenant-subscription.service';
import { limitThreshold, UsageLimitWarningService } from './usage-limit-warning.service';

const metric = (used: number, limit: number | 'unlimited') => ({ used, limit });

function usage(overrides: Record<string, ReturnType<typeof metric>> = {}) {
  return {
    organizationId: 'org-1',
    academies: metric(1, 3),
    students: metric(10, 100),
    instructors: metric(1, 5),
    staff: metric(0, 5),
    courses: metric(2, 40),
    generalStorage: metric(0.5, 10),
    videoStorage: metric(9, 10),
    videoStorageMinutes: metric(0, 100),
    updatedAt: '2026-10-13T00:00:00.000Z',
    ...overrides,
  };
}

function build(getUsage: jest.Mock) {
  const tx = {
    organization: { findUnique: jest.fn().mockResolvedValue({ ownerUserId: 'owner-1' }) },
    tenantSubscription: {
      findUnique: jest.fn().mockResolvedValue({
        currentPeriodStart: new Date('2026-10-01T00:00:00.000Z'),
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
      }),
    },
  };
  const emit = jest.fn().mockResolvedValue({ created: true, outboxId: 'outbox-1' });
  const enqueueAfterCommit = jest.fn().mockResolvedValue(undefined);
  const service = new UsageLimitWarningService(
    {
      runInTenantContext: jest.fn((_org: string, work: (t: unknown) => unknown) =>
        work(tx),
      ),
    } as unknown as TenancyContextService,
    { getUsage } as unknown as TenantSubscriptionService,
    { emit, enqueueAfterCommit } as unknown as CommunicationService,
  );
  return { service, emit, enqueueAfterCommit };
}

describe('limitThreshold (B0-BIL-13)', () => {
  it.each([
    [metric(79, 100), null],
    [metric(80, 100), 'approaching'],
    [metric(99, 100), 'approaching'],
    [metric(100, 100), 'reached'],
    [metric(120, 100), 'reached'],
    [metric(5, 'unlimited'), null],
    [metric(0, 0), null],
  ])('%o → %s', (input, expected) => {
    expect(limitThreshold(input)).toBe(expected);
  });
});

describe('UsageLimitWarningService (B0-BIL-13)', () => {
  it('warns the owner once per crossed limit, with the billing period in the values', async () => {
    const { service, emit, enqueueAfterCommit } = build(
      jest
        .fn()
        .mockResolvedValue(usage({ students: metric(85, 100), courses: metric(40, 40) })),
    );
    await service.checkAndNotify('org-1');
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({
        key: 'billing.limit.approaching',
        recipientUserId: 'owner-1',
        organizationId: 'org-1',
        entity: { type: 'organization', id: 'org-1' },
        values: {
          limitKey: 'students',
          used: '85',
          limit: '100',
          periodKey: '2026-10-01',
        },
      }),
      expect.objectContaining({
        key: 'billing.limit.reached',
        values: { limitKey: 'courses', used: '40', limit: '40', periodKey: '2026-10-01' },
      }),
    ]);
    expect(enqueueAfterCommit).toHaveBeenCalledTimes(2);
  });

  it('ignores limits customers cannot use (video) and unlimited ones', async () => {
    const { service, emit } = build(
      jest.fn().mockResolvedValue(usage({ students: metric(500, 'unlimited') })),
    );
    await service.checkAndNotify('org-1');
    expect(emit).not.toHaveBeenCalled();
  });

  it('formats storage with one decimal', async () => {
    const { service, emit } = build(
      jest.fn().mockResolvedValue(usage({ generalStorage: metric(8.4567, 10) })),
    );
    await service.checkAndNotify('org-1');
    expect(emit.mock.calls[0][1].values).toMatchObject({
      limitKey: 'generalStorage',
      used: '8.5',
      limit: '10',
    });
  });

  it('does nothing without a subscription or usage row, and never throws', async () => {
    const missing = build(jest.fn().mockRejectedValue(new NotFoundException()));
    await expect(missing.service.checkAndNotify('org-1')).resolves.toBeUndefined();
    expect(missing.emit).not.toHaveBeenCalled();

    const broken = build(jest.fn().mockRejectedValue(new Error('db down')));
    await expect(broken.service.checkAndNotify('org-1')).resolves.toBeUndefined();
  });
});
