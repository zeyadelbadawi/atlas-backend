/**
 * Customer Requests — pure helpers: details validation and row → response
 * mapping. No I/O here, so every rule is unit-testable on its own.
 */
import { BadRequestException } from '@nestjs/common';
import type {
  CustomerRequest,
  CustomerRequestEvent,
  CustomerRequestStatus,
  CustomerRequestType,
} from '@prisma/client';
import {
  CLOSED_STATUSES,
  CUSTOMER_REQUEST_DETAIL_FIELDS,
  EMAIL_EXCERPT_LENGTH,
  TEAM_TRANSITIONS,
} from './customer-requests.constants';
import type {
  CustomerRequestDetailResponse,
  CustomerRequestEventResponse,
  CustomerRequestSummaryResponse,
} from './dto/customer-request.contract';

/**
 * Keeps only the type's own contextual fields, trimmed and bounded. An
 * unknown key or a wrong kind is a 400 — never silently stored, never
 * silently dropped (the customer would think it was sent).
 */
export function sanitizeDetails(
  type: CustomerRequestType,
  raw: Record<string, unknown> | undefined,
): Record<string, string | boolean> {
  const fields = CUSTOMER_REQUEST_DETAIL_FIELDS[type];
  const out: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    const field = fields.find((candidate) => candidate.key === key);
    if (!field) {
      throw new BadRequestException({
        messageKey: 'errors.customerRequest.invalidDetails',
        details: { field: key },
      });
    }
    if (value === null || value === undefined || value === '') continue;
    if (field.kind === 'boolean') {
      if (typeof value !== 'boolean') {
        throw new BadRequestException({
          messageKey: 'errors.customerRequest.invalidDetails',
          details: { field: key },
        });
      }
      out[key] = value;
      continue;
    }
    if (typeof value !== 'string' || value.trim().length > (field.maxLength ?? 1000)) {
      throw new BadRequestException({
        messageKey: 'errors.customerRequest.invalidDetails',
        details: { field: key },
      });
    }
    const trimmed = value.trim();
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

/** A short, human reference for emails and support conversations. */
export function requestReference(id: string): string {
  return `CR-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

export function excerpt(text: string): string {
  return text.length > EMAIL_EXCERPT_LENGTH
    ? `${text.slice(0, EMAIL_EXCERPT_LENGTH - 1)}…`
    : text;
}

export function isClosed(status: CustomerRequestStatus): boolean {
  return CLOSED_STATUSES.has(status);
}

export function canTeamMove(
  from: CustomerRequestStatus,
  to: CustomerRequestStatus,
): boolean {
  return TEAM_TRANSITIONS[from].includes(to);
}

type RequestWithAcademy = CustomerRequest & {
  readonly academy: { readonly id: string; readonly name: string };
};

export function toSummary(row: RequestWithAcademy): CustomerRequestSummaryResponse {
  return {
    id: row.id,
    reference: requestReference(row.id),
    type: row.type,
    title: row.title,
    status: row.status,
    priority: row.priority,
    academy: { id: row.academy.id, name: row.academy.name },
    requester: { name: row.requesterName },
    createdAt: row.createdAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
  };
}

export function toEventResponse(
  event: CustomerRequestEvent,
  options: {
    readonly includeVisibility: boolean;
    readonly assigneeNames?: ReadonlyMap<string, string>;
  },
): CustomerRequestEventResponse {
  return {
    id: event.id,
    kind: event.kind,
    ...(options.includeVisibility ? { visibility: event.visibility } : {}),
    actorSide: event.actorSide === 'team' ? 'team' : 'customer',
    actorName: event.actorName,
    body: event.body,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    ...(options.includeVisibility
      ? {
          assignee: event.assigneeUserId
            ? {
                id: event.assigneeUserId,
                name: options.assigneeNames?.get(event.assigneeUserId) ?? '',
              }
            : null,
        }
      : {}),
    createdAt: event.createdAt.toISOString(),
  };
}

/** The academy's view. Only ever given `customer` events (RLS + query). */
export function toCustomerDetail(
  row: RequestWithAcademy,
  events: readonly CustomerRequestEvent[],
): CustomerRequestDetailResponse {
  const closed = isClosed(row.status);
  return {
    ...toSummary(row),
    description: row.description,
    details: (row.details ?? {}) as Record<string, string | boolean>,
    closedAt: row.closedAt?.toISOString() ?? null,
    events: events
      .filter((event) => event.visibility === 'customer')
      .map((event) => toEventResponse(event, { includeVisibility: false })),
    canCancel: !closed,
    canReply: !closed,
  };
}
