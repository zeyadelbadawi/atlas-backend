import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { classValidatorErrorsToViolations } from '../../common/validation/class-validator-violations.util';
import {
  CreatePlanDto,
  UpdatePlanDto,
  assertValidLimits,
  planPricingViolations,
} from './update-plan.dto';

/** B8 (UX audit) V04/V09/V10 — plan prices, trial days and limits, one named violation per field. */
describe('Plan DTOs — price, yearly price, trial days and limits', () => {
  const violationsFor = (payload: Record<string, unknown>) =>
    classValidatorErrorsToViolations(
      validateSync(plainToInstance(UpdatePlanDto, { expectedVersion: 0, ...payload })),
    );
  const monthly = (amount: unknown, yearlyAmount?: unknown) => ({
    pricing: {
      amount,
      currency: 'EGP',
      billingCycle: 'monthly',
      ...(yearlyAmount !== undefined ? { yearlyAmount } : {}),
    },
  });

  const LIMITS = {
    academies: 1,
    students: 100,
    instructors: 'unlimited',
    staff: 0,
    courses: 20,
    generalStorage: 10,
    videoStorage: 10,
    videoStorageMinutes: 100,
    recordedSessions: 0,
  };

  describe('pricing.amount', () => {
    it.each([1, 1190, 1_000_000])('accepts %p', (amount) => {
      expect(violationsFor(monthly(amount))).toEqual([]);
    });

    it.each([-500, 0, 1190.5, 1190.55, 1_000_001, 99_999_999_999, 'abc', '1190', null])(
      'refuses %p with the whole range on pricing.amount',
      (amount) => {
        expect(violationsFor(monthly(amount))).toEqual([
          {
            field: 'pricing.amount',
            messageKey: 'validation:integerRange',
            values: { min: 1, max: 1_000_000 },
          },
        ]);
      },
    );
  });

  describe('pricing.yearlyAmount', () => {
    it.each([0, -1, 2.5, 10_000_001, 'abc'])('refuses %p with its range', (yearly) => {
      expect(violationsFor(monthly(1190, yearly))).toEqual([
        {
          field: 'pricing.yearlyAmount',
          messageKey: 'validation:integerRange',
          values: { min: 1, max: 10_000_000 },
        },
      ]);
    });

    it('refuses a yearly price below the monthly one, naming the monthly price', () => {
      expect(
        planPricingViolations({
          amount: 1190,
          billingCycle: 'monthly',
          yearlyAmount: 1189,
        }),
      ).toEqual([
        {
          field: 'pricing.yearlyAmount',
          messageKey: 'errors.plan.yearlyBelowMonthly',
          values: { min: 1190 },
        },
      ]);
    });

    it('accepts a yearly price equal to or above the monthly one, or none', () => {
      expect(
        planPricingViolations({
          amount: 1190,
          billingCycle: 'monthly',
          yearlyAmount: 1190,
        }),
      ).toEqual([]);
      expect(
        planPricingViolations({
          amount: 1190,
          billingCycle: 'monthly',
          yearlyAmount: 11900,
        }),
      ).toEqual([]);
      expect(planPricingViolations({ amount: 1190, billingCycle: 'monthly' })).toEqual(
        [],
      );
      expect(planPricingViolations(undefined)).toEqual([]);
    });

    it('does not compare a yearly-cycle plan (its yearlyAmount is never offered)', () => {
      expect(
        planPricingViolations({ amount: 9000, billingCycle: 'yearly', yearlyAmount: 10 }),
      ).toEqual([]);
    });
  });

  describe('trialDurationDays', () => {
    it.each([1, 14, 365, null])('accepts %p', (trialDurationDays) => {
      expect(violationsFor({ trialDurationDays })).toEqual([]);
    });

    it.each([-3, 0, 2.5, 366, 1000, 'abc'])(
      'refuses %p with 1..365',
      (trialDurationDays) => {
        expect(violationsFor({ trialDurationDays })).toEqual([
          {
            field: 'trialDurationDays',
            messageKey: 'validation:integerRange',
            values: { min: 1, max: 365 },
          },
        ]);
      },
    );

    it('applies the same rules on create', () => {
      const dto = plainToInstance(CreatePlanDto, {
        key: 'b8-plan',
        name: 'B8 plan',
        displayOrder: 1,
        limits: {},
        features: {},
        trialDurationDays: 1000,
        pricing: { amount: 0, currency: 'EGP', billingCycle: 'monthly' },
      });
      const fields = classValidatorErrorsToViolations(validateSync(dto)).map(
        (v) => v.field,
      );
      expect(fields.sort()).toEqual(['pricing.amount', 'trialDurationDays']);
    });
  });

  describe('limits', () => {
    it('accepts whole numbers from 0 and "unlimited"', () => {
      expect(assertValidLimits(LIMITS)).toEqual([]);
      expect(assertValidLimits({ ...LIMITS, monthlyEmails: 'unlimited' })).toEqual([]);
    });

    it.each([-1, 2.5, '5', null, 'Unlimited'])(
      'refuses %p on limits.<key>, naming the minimum',
      (value) => {
        expect(assertValidLimits({ ...LIMITS, courses: value })).toEqual([
          {
            field: 'limits.courses',
            messageKey: 'errors.plan.limitValue',
            values: { min: 0 },
          },
        ]);
        expect(assertValidLimits({ ...LIMITS, monthlyEmails: value })).toEqual([
          {
            field: 'limits.monthlyEmails',
            messageKey: 'errors.plan.limitValue',
            values: { min: 0 },
          },
        ]);
      },
    );

    it('names a missing required key and an unknown key on their own paths', () => {
      const { staff: _staff, ...withoutStaff } = LIMITS;
      void _staff;
      expect(assertValidLimits({ ...withoutStaff, maxCourses: 5 })).toEqual([
        { field: 'limits.maxCourses', messageKey: 'validation:invalid' },
        { field: 'limits.staff', messageKey: 'validation:required' },
      ]);
    });
  });
});
