/**
 * Plan management (item 9) — the bodies and query of the new Platform
 * Owner routes are validated before any handler runs.
 */
import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateAddOnPricingDto } from './update-add-on-pricing.dto';
import { RestorePlanDto } from './update-plan.dto';
import { PlatformPlanQueryDto } from './platform-plan-query.dto';

const errorsOf = async <T extends object>(
  cls: new () => T,
  value: Record<string, unknown>,
) => validate(plainToInstance(cls, value));

describe('UpdateAddOnPricingDto', () => {
  it('accepts a whole price in a three-letter currency with a version', async () => {
    await expect(
      errorsOf(UpdateAddOnPricingDto, {
        amount: 450,
        currency: 'EGP',
        expectedVersion: 0,
      }),
    ).resolves.toHaveLength(0);
  });

  it.each([
    [
      'a zero price (a free add-on skips checkout)',
      { amount: 0, currency: 'EGP', expectedVersion: 0 },
    ],
    [
      'a price above 1,000,000',
      { amount: 1_000_001, currency: 'EGP', expectedVersion: 0 },
    ],
    ['a fractional price', { amount: 9.5, currency: 'EGP', expectedVersion: 0 }],
    ['a lowercase currency', { amount: 9, currency: 'egp', expectedVersion: 0 }],
    ['no currency', { amount: 9, expectedVersion: 0 }],
    ['no version', { amount: 9, currency: 'EGP' }],
  ])('rejects %s', async (_label, value) => {
    await expect(errorsOf(UpdateAddOnPricingDto, value)).resolves.not.toHaveLength(0);
  });
});

describe('RestorePlanDto', () => {
  it.each([0, 4, 1000])('accepts the position %s', async (displayOrder) => {
    await expect(
      errorsOf(RestorePlanDto, { expectedVersion: 2, displayOrder }),
    ).resolves.toHaveLength(0);
  });

  it.each([
    ['a negative position', { expectedVersion: 2, displayOrder: -1 }],
    ['a position above 1000', { expectedVersion: 2, displayOrder: 1001 }],
    ['no position', { expectedVersion: 2 }],
    ['no version', { displayOrder: 1 }],
  ])('rejects %s', async (_label, value) => {
    await expect(errorsOf(RestorePlanDto, value)).resolves.not.toHaveLength(0);
  });
});

describe('PlatformPlanQueryDto', () => {
  it.each(['listed', 'hidden', 'archived'])(
    'accepts visibility=%s',
    async (visibility) => {
      await expect(errorsOf(PlatformPlanQueryDto, { visibility })).resolves.toHaveLength(
        0,
      );
    },
  );

  it('rejects an unknown visibility and an over-long search', async () => {
    await expect(
      errorsOf(PlatformPlanQueryDto, { visibility: 'draft' }),
    ).resolves.not.toHaveLength(0);
    await expect(
      errorsOf(PlatformPlanQueryDto, { search: 'x'.repeat(101) }),
    ).resolves.not.toHaveLength(0);
  });
});
