import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { classValidatorErrorsToViolations } from '../../common/validation/class-validator-violations.util';
import {
  SubscriptionDaysAdjustmentDto,
  SubscriptionPlanChangeDto,
} from './subscription-adjustment.dto';

/** B8 (UX audit) V05/V12 — each adjustment field is answered on itself, with its numbers. */
describe('Subscription adjustment DTOs', () => {
  const REASON = 'Customer paid by phone; extending while the transfer clears.';
  const days = (payload: Record<string, unknown>) =>
    classValidatorErrorsToViolations(
      validateSync(plainToInstance(SubscriptionDaysAdjustmentDto, payload)),
    );
  const change = (payload: Record<string, unknown>) =>
    classValidatorErrorsToViolations(
      validateSync(plainToInstance(SubscriptionPlanChangeDto, payload)),
    );

  it.each([0, -5, 2.5, 366, 'abc'])('refuses %p days with the 1..365 range', (value) => {
    expect(days({ days: value, reason: REASON })).toEqual([
      {
        field: 'days',
        messageKey: 'errors.platform.subscriptionAdjustment.daysRange',
        values: { min: 1, max: 365 },
      },
    ]);
  });

  it.each(['short', ' '.repeat(12), '   too short   '])(
    'refuses the reason %p (trimmed) with the minimum length',
    (reason) => {
      expect(days({ days: 5, reason })).toEqual([
        {
          field: 'reason',
          messageKey: 'errors.platform.subscriptionAdjustment.reasonTooShort',
          values: { count: 10 },
        },
      ]);
    },
  );

  it('accepts a whole number of days and a real reason', () => {
    expect(days({ days: 365, reason: REASON })).toEqual([]);
  });

  it.each(['', undefined, 'bad key!'])('refuses plan key %p on planKey', (planKey) => {
    expect(change({ planKey, applyAt: 'now', reason: REASON })).toEqual([
      {
        field: 'planKey',
        messageKey: 'errors.platform.subscriptionAdjustment.planRequired',
      },
    ]);
  });

  it('accepts a plan change with a key, a timing and a reason', () => {
    expect(change({ planKey: 'growth', applyAt: 'period_end', reason: REASON })).toEqual(
      [],
    );
  });
});
