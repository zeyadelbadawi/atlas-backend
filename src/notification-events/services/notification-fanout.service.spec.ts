import { NotificationFanoutService } from './notification-fanout.service';
import type { NotificationsRepository } from '../repositories/notifications.repository';
import type { UsersRepository } from '../../identity/repositories/users.repository';
import type { EmailService } from './email.service';

function buildService(overrides: {
  findById?: jest.Mock;
  create?: jest.Mock;
  sendTemplated?: jest.Mock;
}) {
  const notificationsRepository = {
    create: overrides.create ?? jest.fn(),
  } as unknown as NotificationsRepository;
  const usersRepository = {
    findById: overrides.findById ?? jest.fn(),
  } as unknown as UsersRepository;
  const emailService = {
    sendTemplated: overrides.sendTemplated ?? jest.fn(),
  } as unknown as EmailService;

  return new NotificationFanoutService(
    notificationsRepository,
    usersRepository,
    emailService,
  );
}

describe('NotificationFanoutService', () => {
  describe('notify', () => {
    it('delegates directly to the repository, returning whether a new row was created', async () => {
      const create = jest.fn().mockResolvedValue(true);
      const service = buildService({ create });
      const tx = {} as never;

      const result = await service.notify(tx, {
        userId: 'user-1',
        type: 'system',
        priority: 'medium',
        titleKey: 'notifications:events.x.title',
        messageKey: 'notifications:events.x.message',
      });

      expect(result).toBe(true);
      expect(create).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ userId: 'user-1' }),
      );
    });
  });

  describe('sendEmailAfterCommit', () => {
    it('does not send an email when the notification was a deduped no-op', async () => {
      const sendTemplated = jest.fn();
      const service = buildService({ sendTemplated });

      await service.sendEmailAfterCommit('user-1', false, {
        template: 'password_changed',
      });

      expect(sendTemplated).not.toHaveBeenCalled();
    });

    it('does not send an email when the user has email notifications disabled', async () => {
      const findById = jest.fn().mockResolvedValue({
        email: 'user@example.com',
        preferences: { notifications: { email: false, push: false, sms: false } },
      });
      const sendTemplated = jest.fn();
      const service = buildService({ findById, sendTemplated });

      await service.sendEmailAfterCommit('user-1', true, {
        template: 'password_changed',
      });

      expect(sendTemplated).not.toHaveBeenCalled();
    });

    it('sends an email when the notification was newly created and email is enabled (the default)', async () => {
      const findById = jest.fn().mockResolvedValue({
        email: 'user@example.com',
        preferences: {},
      });
      const sendTemplated = jest.fn();
      const service = buildService({ findById, sendTemplated });

      await service.sendEmailAfterCommit('user-1', true, {
        template: 'password_changed',
        values: {},
      });

      expect(sendTemplated).toHaveBeenCalledWith(
        'user@example.com',
        'password_changed',
        {},
      );
    });

    it('does nothing when the user no longer exists (never throws)', async () => {
      const findById = jest.fn().mockResolvedValue(null);
      const sendTemplated = jest.fn();
      const service = buildService({ findById, sendTemplated });

      await expect(
        service.sendEmailAfterCommit('deleted-user', true, {
          template: 'password_changed',
        }),
      ).resolves.toBeUndefined();
      expect(sendTemplated).not.toHaveBeenCalled();
    });
  });
});
