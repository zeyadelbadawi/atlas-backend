// `CollectionQueryDto`'s `@Type(() => Number)` decorators need
// `Reflect.getMetadata` — no other spec file in this codebase has yet
// unit-tested a DTO that extends it directly (every other consumer is
// only ever exercised inside a full Nest app in an e2e run, where
// `@nestjs/common`'s own import chain already polyfills this as a side
// effect). Explicit here since this file's own module graph doesn't
// otherwise trigger it.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListNotificationsQueryDto } from './list-notifications-query.dto';

async function validateQuery(payload: Record<string, unknown>) {
  const dto = plainToInstance(ListNotificationsQueryDto, payload);
  return validate(dto);
}

describe('ListNotificationsQueryDto', () => {
  it('accepts an empty payload (every field optional)', async () => {
    expect(await validateQuery({})).toHaveLength(0);
  });

  it('accepts a valid isRead boolean-string filter', async () => {
    expect(await validateQuery({ isRead: 'true' })).toHaveLength(0);
    expect(await validateQuery({ isRead: 'false' })).toHaveLength(0);
  });

  it('rejects a non-boolean-string isRead value', async () => {
    const errors = await validateQuery({ isRead: 'not-a-boolean' });
    expect(errors.some((e) => e.property === 'isRead')).toBe(true);
  });

  it('accepts every real NotificationType value', async () => {
    for (const type of [
      'system',
      'account',
      'billing',
      'security',
      'activity',
      'announcement',
    ]) {
      expect(await validateQuery({ type })).toHaveLength(0);
    }
  });

  it('rejects an invalid type', async () => {
    const errors = await validateQuery({ type: 'not-a-type' });
    expect(errors.some((e) => e.property === 'type')).toBe(true);
  });

  it('accepts every real NotificationPriority value', async () => {
    for (const priority of ['low', 'medium', 'high', 'urgent']) {
      expect(await validateQuery({ priority })).toHaveLength(0);
    }
  });

  it('rejects an invalid priority', async () => {
    const errors = await validateQuery({ priority: 'not-a-priority' });
    expect(errors.some((e) => e.property === 'priority')).toBe(true);
  });
});
