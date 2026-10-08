/**
 * NotificationsService — `GET /notifications`, `GET /notifications/summary`,
 * `PATCH /notifications/:id/read`, `POST /notifications/read-all`,
 * `GET/PATCH /notifications/preferences` (master plan §21 Phase P17). Every
 * read/write is user-scoped — the backend infers "my notifications" from
 * the session, matching `NotificationService`'s (frontend) own doc
 * comment exactly. No id is ever accepted from the client for "which
 * user" — always `auth.userId` from the verified JWT.
 *
 * Preferences read/write reuse P1's `UsersRepository.mergePreferences`
 * directly (the exact same `users.preferences.notifications` JSON
 * sub-object `PATCH /users/me/preferences` already manages) — never a
 * second preferences store. `NotificationPreferencesDto` (P1's own DTO
 * class) is reused verbatim for the PATCH body, matching that class's own
 * doc comment: "a caller that wants to change one notification channel
 * sends the whole `notifications` object."
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { NotificationsRepository } from '../../notification-events/repositories/notifications.repository';
import type { NotificationScope } from '../../notification-events/repositories/notifications.repository';
import { resolveNotificationPreferences } from '../../notification-events/notification-preferences.util';
import { toNotificationResponse } from '../dto/notification.contract';
import type {
  NotificationResponse,
  NotificationSummaryResponse,
} from '../dto/notification.contract';
import type { NotificationPreferencesDto } from '../../identity/dto/update-preferences.dto';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { ListNotificationsQueryDto } from '../dto/list-notifications-query.dto';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly notificationsRepository: NotificationsRepository,
    private readonly usersRepository: UsersRepository,
  ) {}

  async listNotifications(
    userId: string,
    scope: NotificationScope,
    query: ListNotificationsQueryDto,
  ): Promise<PaginatedResult<NotificationResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInUserContext(
      userId,
      (tx) =>
        this.notificationsRepository.findMany(tx, userId, scope, {
          isRead: query.isRead === undefined ? undefined : query.isRead === 'true',
          type: query.type,
          priority: query.priority,
          skip: (page - 1) * pageSize,
          take: pageSize,
          sortDirection: query.sortDirection ?? 'desc',
        }),
    );

    return {
      items: items.map(toNotificationResponse),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  async getSummary(
    userId: string,
    scope: NotificationScope,
  ): Promise<NotificationSummaryResponse> {
    const summary = await this.tenancyContextService.runInUserContext(userId, (tx) =>
      this.notificationsRepository.getSummary(tx, userId, scope),
    );

    const byType = {
      system: 0,
      account: 0,
      billing: 0,
      security: 0,
      activity: 0,
      announcement: 0,
    };
    for (const row of summary.byType) byType[row.type as keyof typeof byType] = row.count;

    const byPriority = { low: 0, medium: 0, high: 0, urgent: 0 };
    for (const row of summary.byPriority)
      byPriority[row.priority as keyof typeof byPriority] = row.count;

    return { total: summary.total, unread: summary.unread, byType, byPriority };
  }

  async markAsRead(
    userId: string,
    scope: NotificationScope,
    notificationId: string,
  ): Promise<NotificationResponse> {
    const updated = await this.tenancyContextService.runInUserContext(userId, (tx) =>
      this.notificationsRepository.markAsRead(tx, userId, scope, notificationId),
    );
    if (!updated) {
      // Covers both "doesn't exist" and "belongs to someone else" — never
      // distinguishing the two in the response (master plan §18's own
      // "never leak existence of another user's resource" posture,
      // matching every other self-scoped 404 in this codebase) — and now
      // also "belongs to another context" (Management vs an academy).
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    return toNotificationResponse(updated);
  }

  async markAllAsRead(
    userId: string,
    scope: NotificationScope,
    before?: Date,
  ): Promise<void> {
    await this.tenancyContextService.runInUserContext(userId, (tx) =>
      this.notificationsRepository.markAllAsRead(tx, userId, scope, before),
    );
  }

  async getPreferences(userId: string): Promise<NotificationPreferencesDto> {
    const user = await this.usersRepository.findById(userId);
    if (!user) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return resolveNotificationPreferences(user.preferences);
  }

  async updatePreferences(
    userId: string,
    dto: NotificationPreferencesDto,
  ): Promise<NotificationPreferencesDto> {
    // P64 Communications — `mergePreferences` merges at the TOP level, so
    // the whole `notifications` sub-object is rewritten here: carry the
    // communication `categories` across and keep `engagement.email` in
    // step with the legacy flag so the two surfaces never disagree.
    const user = await this.usersRepository.findById(userId);
    const existing = ((
      user?.preferences as { notifications?: Record<string, unknown> } | null
    )?.notifications ?? {}) as { categories?: Record<string, unknown> };
    const categories = {
      ...(existing.categories ?? {}),
      engagement: {
        ...((existing.categories?.engagement as Record<string, unknown> | undefined) ??
          {}),
        email: dto.email,
      },
    };
    const updated = await this.usersRepository.mergePreferences(userId, {
      notifications: { email: dto.email, push: dto.push, sms: dto.sms, categories },
    });
    return resolveNotificationPreferences(updated.preferences);
  }
}
