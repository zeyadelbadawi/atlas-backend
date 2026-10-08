/** Customer Requests — response shapes (mirrored by the frontend types). */
import type {
  CustomerRequestEventKind,
  CustomerRequestPriority,
  CustomerRequestStatus,
  CustomerRequestType,
} from '@prisma/client';

export interface CustomerRequestSummaryResponse {
  readonly id: string;
  readonly reference: string;
  readonly type: CustomerRequestType;
  readonly title: string;
  readonly status: CustomerRequestStatus;
  readonly priority: CustomerRequestPriority;
  readonly academy: { readonly id: string; readonly name: string };
  readonly requester: { readonly name: string };
  readonly createdAt: string;
  readonly lastActivityAt: string;
}

export interface CustomerRequestEventResponse {
  readonly id: string;
  readonly kind: CustomerRequestEventKind;
  /** Present only in the platform view; academy views only ever hold `customer` events. */
  readonly visibility?: 'customer' | 'internal';
  readonly actorSide: 'customer' | 'team';
  readonly actorName: string;
  readonly body: string | null;
  readonly fromStatus: CustomerRequestStatus | null;
  readonly toStatus: CustomerRequestStatus | null;
  readonly assignee?: { readonly id: string; readonly name: string } | null;
  readonly createdAt: string;
}

export interface CustomerRequestDetailResponse extends CustomerRequestSummaryResponse {
  readonly description: string;
  readonly details: Record<string, string | boolean>;
  readonly closedAt: string | null;
  readonly events: readonly CustomerRequestEventResponse[];
  /** What the customer may do now (cancel, reply). */
  readonly canCancel: boolean;
  readonly canReply: boolean;
}

export interface PlatformCustomerRequestSummaryResponse extends CustomerRequestSummaryResponse {
  readonly organization: { readonly id: string; readonly name: string };
  readonly assignee: { readonly id: string; readonly name: string } | null;
}

export interface PlatformCustomerRequestDetailResponse extends CustomerRequestDetailResponse {
  readonly organization: { readonly id: string; readonly name: string };
  readonly requesterEmail: string;
  readonly assignee: { readonly id: string; readonly name: string } | null;
  /** Statuses the team may move this request to now. */
  readonly allowedStatuses: readonly CustomerRequestStatus[];
  /** Where its emails go (the configured inbox, or null → Platform Owners). */
  readonly routedTo: string | null;
}

export interface CustomerRequestCountsResponse {
  readonly open: number;
  readonly byStatus: Record<CustomerRequestStatus, number>;
}

export interface RoutingRuleResponse {
  readonly type: CustomerRequestType;
  readonly email: string | null;
  readonly updatedAt: string | null;
}

export interface PlatformOwnerOptionResponse {
  readonly id: string;
  readonly name: string;
}
