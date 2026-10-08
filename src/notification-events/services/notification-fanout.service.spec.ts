import { NotificationFanoutService } from './notification-fanout.service';
import type { NotificationsRepository } from '../repositories/notifications.repository';

describe('NotificationFanoutService', () => {
  it('notify delegates to the repository and returns whether a new row was created', async () => {
    const create = jest.fn().mockResolvedValue(true);
    const service = new NotificationFanoutService({
      create,
    } as unknown as NotificationsRepository);
    const tx = {} as never;

    const result = await service.notify(tx, {
      userId: 'user-1',
      type: 'system',
      priority: 'medium',
      titleKey: 'notifications:events.x.title',
      context: 'management' as const,
      messageKey: 'notifications:events.x.message',
    });

    expect(result).toBe(true);
    expect(create).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ userId: 'user-1' }),
    );
  });

  it('reports a deduped retry as false', async () => {
    const service = new NotificationFanoutService({
      create: jest.fn().mockResolvedValue(false),
    } as unknown as NotificationsRepository);
    await expect(
      service.notify({} as never, {
        userId: 'user-1',
        type: 'system',
        priority: 'medium',
        titleKey: 't',
        messageKey: 'm',
        context: 'management',
        dedupeKey: 'k',
      }),
    ).resolves.toBe(false);
  });
});
