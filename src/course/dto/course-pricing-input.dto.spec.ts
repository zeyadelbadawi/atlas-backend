import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CoursePricingInputDto } from './course-pricing-input.dto';

/**
 * Regression test for the P5 closure pass (2026-08-24): the frontend's
 * `createCourseSchema`/`updateCourseSchema` (`course.schemas.ts`) already
 * enforce, via `.refine()`, that `amount` must be a positive number whenever
 * `pricingType === 'paid'` — but `CoursePricingInputDto` did not re-enforce
 * this server-side, so a direct API call (bypassing the frontend form)
 * could persist a `paid` course with no price at all. Never trust the
 * client-side check alone, matching this codebase's discipline everywhere
 * else — this is the same DTO validated by the real e2e suite in
 * `test/courses.e2e-spec.ts`.
 */
describe('CoursePricingInputDto', () => {
  async function validateDto(payload: Record<string, unknown>) {
    const dto = plainToInstance(CoursePricingInputDto, payload);
    return validate(dto);
  }

  it('accepts a free course with no amount', async () => {
    const errors = await validateDto({ type: 'free' });
    expect(errors).toHaveLength(0);
  });

  it('accepts a paid course with a positive amount', async () => {
    const errors = await validateDto({ type: 'paid', amount: 29.99, currency: 'USD' });
    expect(errors).toHaveLength(0);
  });

  it('rejects a paid course with no amount at all', async () => {
    const errors = await validateDto({ type: 'paid', currency: 'USD' });
    expect(errors.some((e) => e.property === 'amount')).toBe(true);
  });

  it('rejects a paid course with amount = 0', async () => {
    const errors = await validateDto({ type: 'paid', amount: 0, currency: 'USD' });
    expect(errors.some((e) => e.property === 'amount')).toBe(true);
  });

  it('rejects a paid course with a negative amount', async () => {
    const errors = await validateDto({ type: 'paid', amount: -10, currency: 'USD' });
    expect(errors.some((e) => e.property === 'amount')).toBe(true);
  });

  it('does not require an amount for a free course even if type is checked first', async () => {
    // Guards against a naive implementation that validates `amount` before
    // `type` is known to `class-transformer` — order-of-property-declaration
    // independence.
    const errors = await validateDto({ type: 'free', amount: undefined });
    expect(errors).toHaveLength(0);
  });
});
