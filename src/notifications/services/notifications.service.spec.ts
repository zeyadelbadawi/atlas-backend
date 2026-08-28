import { NotFoundException } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import type { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import type { NotificationsRepository } from '../../notification-events/repositories/notifications.repository';
import type { UsersRepository } from '../../identity/repositories/users.repository';

function buildService(overrides: {
  markAsRead?: jest.Mock;
  markAllAsRead?: jest.Mock;
  getSummary?: jest.Mock;
  findById?: jest.Mock;
  mergePreferences?: jest.Mock;
}) {
  const tx = {} as never;
  const tenancyContextService = {
    runInUserContext: jest.fn((_userId: string, work: (tx: unknown) => unknown) =>
      work(tx),
    ),
  } as unknown as TenancyContextService;

  const notificationsRepository = {
    markAsRead: overrides.markAsRead ?? jest.fn(),
    markAllAsRead: overrides.markAllAsRead ?? jest.fn(),
    getSummary: overrides.getSummary ?? jest.fn(),
    findMany: jest.fn(),
  } as unknown as NotificationsRepository;

  const usersRepository = {
    findById: overrides.findById ?? jest.fn(),
    mergePreferences: overrides.mergePreferences ?? jest.fn(),
  } as unknown as UsersRepository;

  return new NotificationsService(
    tenancyContextService,
    notificationsRepository,
    usersRepository,
  );
}

const NOW = new Date('2026-08-28T00:00:00.000Z');
function fakeNotification(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'notif-1',
    userId: 'user-1',
    type: 'system',
    priority: 'medium',
    titleKey: 'notifications:events.x.title',
    messageKey: 'notifications:events.x.message',
    values: null,
    isRead: false,
    actionUrl: null,
    actionLabelKey: null,
    metadata: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('NotificationsService', () => {
  describe('markAsRead', () => {
    it('returns the updated notification when it belongs to the caller', async () => {
      const markAsRead = jest.fn().mockResolvedValue(fakeNotification({ isRead: true }));
      const service = buildService({ markAsRead });

      const result = await service.markAsRead('user-1', 'notif-1');

      expect(result.isRead).toBe(true);
      expect(markAsRead).toHaveBeenCalledWith(expect.anything(), 'user-1', 'notif-1');
    });

    it('throws NotFound — never distinguishing "does not exist" from "belongs to someone else" — when the repository finds no matching row', async () => {
      const markAsRead = jest.fn().mockResolvedValue(null);
      const service = buildService({ markAsRead });

      await expect(
        service.markAsRead('user-1', 'someone-elses-notification'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getSummary', () => {
    it('fills every NotificationType/Priority key, even ones with zero notifications', async () => {
      const getSummary = jest.fn().mockResolvedValue({
        total: 3,
        unread: 1,
        byType: [{ type: 'billing', count: 3 }],
        byPriority: [{ priority: 'high', count: 1 }],
      });
      const service = buildService({ getSummary });

      const summary = await service.getSummary('user-1');

      expect(summary).toEqual({
        total: 3,
        unread: 1,
        byType: {
          system: 0,
          account: 0,
          billing: 3,
          security: 0,
          activity: 0,
          announcement: 0,
        },
        byPriority: { low: 0, medium: 0, high: 1, urgent: 0 },
      });
    });
  });

  describe('preferences', () => {
    it('returns the honest default when the user has never set preferences', async () => {
      const findById = jest.fn().mockResolvedValue({ preferences: {} });
      const service = buildService({ findById });

      expect(await service.getPreferences('user-1')).toEqual({
        email: true,
        push: false,
        sms: false,
      });
    });

    it('updatePreferences merges only the notifications sub-object and returns it', async () => {
      const mergePreferences = jest.fn().mockResolvedValue({
        preferences: { notifications: { email: false, push: true, sms: true } },
      });
      const service = buildService({ mergePreferences });

      const result = await service.updatePreferences('user-1', {
        email: false,
        push: true,
        sms: true,
      });

      expect(result).toEqual({ email: false, push: true, sms: true });
      expect(mergePreferences).toHaveBeenCalledWith('user-1', {
        notifications: { email: false, push: true, sms: true },
      });
    });
  });
});
