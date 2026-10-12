import { isLimitDowngrade, shouldScheduleDowngrade } from './scheduled-plan-change.util';
import type { PlanResourceLimits } from '../../plans/dto/entitlement.types';

const limits = (
  over: Partial<Record<string, number | 'unlimited'>>,
): PlanResourceLimits =>
  ({
    academies: 1,
    students: 100,
    instructors: 3,
    staff: 3,
    courses: 20,
    generalStorage: 10,
    videoStorage: 30,
    videoStorageMinutes: 60,
    recordedSessions: 0,
    ...over,
  }) as unknown as PlanResourceLimits;

describe('isLimitDowngrade', () => {
  it('is a downgrade when any limit drops', () => {
    expect(isLimitDowngrade(limits({ students: 400 }), limits({ students: 100 }))).toBe(
      true,
    );
    expect(
      isLimitDowngrade(limits({ courses: 'unlimited' }), limits({ courses: 500 })),
    ).toBe(true);
  });

  it('is not a downgrade when every limit stays or grows', () => {
    expect(isLimitDowngrade(limits({}), limits({ students: 400 }))).toBe(false);
    expect(isLimitDowngrade(limits({}), limits({ courses: 'unlimited' }))).toBe(false);
    expect(isLimitDowngrade(limits({}), limits({}))).toBe(false);
  });
});

describe('shouldScheduleDowngrade', () => {
  const now = new Date('2026-10-12T00:00:00Z');
  const base = {
    currentPlanId: 'academy',
    nextPlanId: 'teacher',
    currentLimits: limits({ students: 400 }),
    nextLimits: limits({ students: 100 }),
    now,
  };

  it('schedules a downgrade with more than 7 days left', () => {
    expect(
      shouldScheduleDowngrade({
        ...base,
        currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
      }),
    ).toBe(true);
  });

  it('applies at once within the last 7 days, for an upgrade, or for the same plan', () => {
    const end = new Date('2026-10-18T00:00:00Z');
    expect(shouldScheduleDowngrade({ ...base, currentPeriodEnd: end })).toBe(false);
    const far = new Date('2026-11-01T00:00:00Z');
    expect(
      shouldScheduleDowngrade({
        ...base,
        currentPeriodEnd: far,
        currentLimits: base.nextLimits,
        nextLimits: base.currentLimits,
      }),
    ).toBe(false);
    expect(
      shouldScheduleDowngrade({ ...base, currentPeriodEnd: far, nextPlanId: 'academy' }),
    ).toBe(false);
  });
});
