import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateSupportCaseStatusDto } from './update-support-case-status.dto';

describe('UpdateSupportCaseStatusDto', () => {
  async function validateDto(payload: Record<string, unknown>) {
    const dto = plainToInstance(UpdateSupportCaseStatusDto, payload);
    return validate(dto);
  }

  it.each(['open', 'in_progress', 'resolved', 'closed'])(
    'accepts the standard lifecycle status %p',
    async (status) => {
      const errors = await validateDto({ status });
      expect(errors).toHaveLength(0);
    },
  );

  it('rejects an invented status', async () => {
    const errors = await validateDto({ status: 'archived' });
    expect(errors.some((e) => e.property === 'status')).toBe(true);
  });

  it('rejects a missing status', async () => {
    const errors = await validateDto({});
    expect(errors.some((e) => e.property === 'status')).toBe(true);
  });
});
