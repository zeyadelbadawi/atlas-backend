/**
 * `GET /notifications`/`GET /notifications/:id/read` response — matches
 * `Notification` (`notifications.types.ts`) field-for-field.
 * `NotificationSummary` matches its own frontend type exactly (four
 * fields, `byType`/`byPriority` fully keyed for every enum value, never a
 * sparse object the frontend would need to default-fill itself).
 */
import type { Notification as NotificationRow } from '@prisma/client';

export interface NotificationResponse {
  readonly id: string;
  readonly userId: string;
  readonly type: string;
  readonly priority: string;
  readonly titleKey: string;
  readonly messageKey: string;
  readonly values?: Record<string, unknown>;
  readonly isRead: boolean;
  readonly actionUrl?: string;
  readonly actionLabelKey?: string;
  readonly metadata?: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toNotificationResponse(row: NotificationRow): NotificationResponse {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type,
    priority: row.priority,
    titleKey: row.titleKey,
    messageKey: row.messageKey,
    values: (row.values as Record<string, unknown> | null) ?? undefined,
    isRead: row.isRead,
    actionUrl: row.actionUrl ?? undefined,
    actionLabelKey: row.actionLabelKey ?? undefined,
    metadata: (row.metadata as Record<string, unknown> | null) ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const NOTIFICATION_TYPES = [
  'system',
  'account',
  'billing',
  'security',
  'activity',
  'announcement',
] as const;

export const NOTIFICATION_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

export interface NotificationSummaryResponse {
  readonly total: number;
  readonly unread: number;
  readonly byType: Record<(typeof NOTIFICATION_TYPES)[number], number>;
  readonly byPriority: Record<(typeof NOTIFICATION_PRIORITIES)[number], number>;
}
