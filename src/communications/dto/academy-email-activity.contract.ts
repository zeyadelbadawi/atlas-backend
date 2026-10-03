/**
 * W3 — wire shapes of the Academy Email Activity API. Deliberately narrow:
 * no `values`, no subject or body, no raw provider error and no full
 * address can be represented here at all.
 */
import type {
  EmailActivityStatus,
  EmailErrorCategory,
} from '../utils/email-activity-status.util';

export interface EmailActivityItem {
  readonly id: string;
  readonly key: string;
  readonly category: string;
  /** True for credential emails (codes, links): listed, with status only. */
  readonly security: boolean;
  readonly status: EmailActivityStatus;
  /** Raw provider delivery status from the latest email attempt (webhooks fill `delivered`/`bounced`/…), or `null`. */
  readonly deliveryStatus: string | null;
  readonly provider: string | null;
  readonly errorCategory: EmailErrorCategory | null;
  readonly recipient: { readonly maskedEmail: string | null };
  readonly academy: { readonly id: string; readonly name: string | null };
  readonly locale: string;
  readonly attempts: number;
  readonly createdAt: string;
  readonly dispatchedAt: string | null;
  readonly deliveryUpdatedAt: string | null;
}

export interface EmailActivityPage {
  readonly items: readonly EmailActivityItem[];
  readonly nextCursor: string | null;
  readonly window: { readonly from: string; readonly to: string };
}

export interface EmailActivityAcademySummary {
  readonly academyId: string;
  readonly academyName: string | null;
  readonly total: number;
  readonly byStatus: Readonly<Record<EmailActivityStatus, number>>;
}

export interface EmailActivitySummary {
  readonly window: { readonly from: string; readonly to: string };
  readonly total: number;
  readonly byStatus: Readonly<Record<EmailActivityStatus, number>>;
  /** Busiest academies in the window (up to 20); one entry when filtered to an academy. */
  readonly academies: readonly EmailActivityAcademySummary[];
  /** Whether provider webhooks have confirmed any delivery in the window — otherwise "Delivered" cannot appear. */
  readonly deliveryWebhooksObserved: boolean;
}
