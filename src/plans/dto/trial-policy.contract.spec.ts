import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { classValidatorErrorsToViolations } from '../../common/validation/class-validator-violations.util';
import { UpdateTrialPolicyDto } from './trial-policy.contract';

/** B8 (UX audit) V23 — the trial policy's length is a whole number of days from 1 to 365. */
describe('UpdateTrialPolicyDto', () => {
  const violationsFor = (durationDays: unknown) =>
    classValidatorErrorsToViolations(
      validateSync(
        plainToInstance(UpdateTrialPolicyDto, { enabled: true, durationDays }),
      ),
    );

  it.each([1, 14, 365])('accepts %p', (days) => {
    expect(violationsFor(days)).toEqual([]);
  });

  it.each([0, -3, 2.5, 366, 1000, 'abc'])('refuses %p, naming 1..365', (days) => {
    expect(violationsFor(days)).toEqual([
      {
        field: 'durationDays',
        messageKey: 'validation:integerRange',
        values: { min: 1, max: 365 },
      },
    ]);
  });
});
