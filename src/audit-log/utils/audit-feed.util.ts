/**
 * Translates an `AuditFeedQueryDto` into a repository `AuditLogFeedFilter`.
 * Shared by the Academy activity log and the Platform audit feed so both
 * interpret `category`/`action`/cursor identically.
 */
import { BadRequestException } from '@nestjs/common';
import { actionsInCategory } from '../catalog/audit-event-catalog';
import { decodeAuditCursor } from '../dto/audit-log.contract';
import {
  DEFAULT_AUDIT_FEED_LIMIT,
  type AuditFeedQueryDto,
} from '../dto/audit-feed-query.dto';
import type { AuditLogFeedFilter } from '../repositories/audit-log-entries.repository';

/**
 * `baseActions` is the outer visibility bound (the tenant list) — `category`
 * and `action` can only NARROW it. An `action` outside the bound yields an
 * empty `actions` list, i.e. an empty page, rather than an error that would
 * confirm the action exists.
 */
export function buildAuditFeedFilter(
  query: AuditFeedQueryDto,
  baseActions?: readonly string[],
): AuditLogFeedFilter {
  let actions: readonly string[] | undefined = baseActions;
  if (query.category) {
    const inCategory = new Set<string>(actionsInCategory(query.category));
    actions = (actions ?? [...inCategory]).filter((action) => inCategory.has(action));
  }
  if (query.action) {
    actions = actions
      ? actions.filter((action) => action === query.action)
      : [query.action];
  }

  let cursor: AuditLogFeedFilter['cursor'];
  if (query.cursor) {
    cursor = decodeAuditCursor(query.cursor);
    if (!cursor)
      throw new BadRequestException({ messageKey: 'errors.validation.failed' });
  }

  return {
    actions,
    actorUserId: query.actorUserId,
    targetType: query.targetType,
    occurredFrom: query.occurredFrom ? new Date(query.occurredFrom) : undefined,
    occurredTo: query.occurredTo ? new Date(query.occurredTo) : undefined,
    search: query.search?.trim() || undefined,
    cursor,
    take: query.limit ?? DEFAULT_AUDIT_FEED_LIMIT,
  };
}
