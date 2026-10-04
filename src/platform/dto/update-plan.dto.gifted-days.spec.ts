import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePlanDto, UpdatePlanDto } from './update-plan.dto';

/** W8 — gifted setup days: null/0 (none) or a whole number 5..15, both cycles, both DTOs. */
describe('Plan DTOs — gifted setup days validation (5..15)', () => {
  async function errorsFor(payload: Record<string, unknown>) {
    const dto = plainToInstance(UpdatePlanDto, { expectedVersion: 0, ...payload });
    const errors = await validate(dto);
    return errors.filter((e) => e.property.startsWith('giftedDays'));
  }

  it.each([5, 7, 10, 14, 15, 0, null])('accepts %p for both cycles', async (value) => {
    expect(
      await errorsFor({ giftedDaysMonthly: value, giftedDaysYearly: value }),
    ).toHaveLength(0);
  });

  it('accepts the fields being omitted (partial edit)', async () => {
    expect(await errorsFor({})).toHaveLength(0);
  });

  it.each([4, 16, -1, 1, 30, 7.5, '7', true])('rejects %p', async (value) => {
    const errors = await errorsFor({ giftedDaysMonthly: value, giftedDaysYearly: value });
    expect(errors.map((e) => e.property).sort()).toEqual([
      'giftedDaysMonthly',
      'giftedDaysYearly',
    ]);
    for (const error of errors) {
      expect(Object.values(error.constraints ?? {})).toContain(
        'errors.plan.giftedDaysRange',
      );
    }
  });

  it('applies the same rule on create', async () => {
    const dto = plainToInstance(CreatePlanDto, {
      key: 'gift-plan',
      name: 'Gift plan',
      displayOrder: 1,
      limits: {},
      features: {},
      giftedDaysMonthly: 16,
      giftedDaysYearly: 14,
    });
    const errors = (await validate(dto)).filter((e) =>
      e.property.startsWith('giftedDays'),
    );
    expect(errors.map((e) => e.property)).toEqual(['giftedDaysMonthly']);
  });
});
