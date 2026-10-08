/**
 * Customer Requests — the vocabulary every layer shares.
 *
 * A request is a custom service an academy's owner/administrator asks the
 * Atlas team for (a logo, a custom domain, a theme, a website section, a
 * feature). It is a business workflow, not a contact form: it has a
 * lifecycle, a conversation, internal notes, an assignee and a history.
 */
import type {
  AcademyMemberRole,
  CustomerRequestStatus,
  CustomerRequestType,
} from '@prisma/client';

/** Who in an academy may file and follow requests. */
export const CUSTOMER_REQUEST_ACADEMY_ROLES: readonly AcademyMemberRole[] = [
  'owner',
  'administrator',
];

export const CUSTOMER_REQUEST_TYPES: readonly CustomerRequestType[] = [
  'logo',
  'domain',
  'theme',
  'custom_section',
  'custom_feature',
];

export const CUSTOMER_REQUEST_STATUSES: readonly CustomerRequestStatus[] = [
  'submitted',
  'received',
  'under_review',
  'in_progress',
  'waiting_for_customer',
  'completed',
  'rejected',
  'cancelled',
];

/** Nothing moves out of these (a completed request may be reopened by the team). */
export const CLOSED_STATUSES: ReadonlySet<CustomerRequestStatus> = new Set([
  'completed',
  'rejected',
  'cancelled',
]);

/**
 * The moves the TEAM may make. Cancelling is the customer's own decision,
 * so the team never sets `cancelled`; a declined or cancelled request is
 * final; a completed one can be reopened when the customer comes back.
 */
export const TEAM_TRANSITIONS: Readonly<
  Record<CustomerRequestStatus, readonly CustomerRequestStatus[]>
> = {
  submitted: [
    'received',
    'under_review',
    'in_progress',
    'waiting_for_customer',
    'rejected',
  ],
  received: [
    'under_review',
    'in_progress',
    'waiting_for_customer',
    'completed',
    'rejected',
  ],
  under_review: ['in_progress', 'waiting_for_customer', 'completed', 'rejected'],
  in_progress: ['under_review', 'waiting_for_customer', 'completed', 'rejected'],
  waiting_for_customer: ['under_review', 'in_progress', 'completed', 'rejected'],
  completed: ['in_progress'],
  rejected: [],
  cancelled: [],
};

/**
 * Contextual fields per type — only what that kind of request needs. Every
 * value is optional free text (or a yes/no), bounded; unknown keys are
 * refused rather than stored.
 */
export interface DetailField {
  readonly key: string;
  readonly kind: 'text' | 'boolean';
  readonly maxLength?: number;
}

export const CUSTOMER_REQUEST_DETAIL_FIELDS: Readonly<
  Record<CustomerRequestType, readonly DetailField[]>
> = {
  logo: [
    { key: 'brandName', kind: 'text', maxLength: 120 },
    { key: 'style', kind: 'text', maxLength: 500 },
    { key: 'colors', kind: 'text', maxLength: 300 },
    { key: 'references', kind: 'text', maxLength: 1000 },
  ],
  domain: [
    { key: 'desiredDomain', kind: 'text', maxLength: 253 },
    { key: 'alreadyOwned', kind: 'boolean' },
    { key: 'registrar', kind: 'text', maxLength: 120 },
  ],
  theme: [
    { key: 'style', kind: 'text', maxLength: 500 },
    { key: 'colors', kind: 'text', maxLength: 300 },
    { key: 'references', kind: 'text', maxLength: 1000 },
    { key: 'requirements', kind: 'text', maxLength: 2000 },
  ],
  custom_section: [
    { key: 'page', kind: 'text', maxLength: 200 },
    { key: 'references', kind: 'text', maxLength: 1000 },
  ],
  custom_feature: [
    { key: 'problem', kind: 'text', maxLength: 2000 },
    { key: 'expectedOutcome', kind: 'text', maxLength: 2000 },
  ],
};

/** Excerpt length for notification emails; the full text stays in the dashboard. */
export const EMAIL_EXCERPT_LENGTH = 600;

/** Notifying Platform Owners: bounded transactions, like the contact inbox. */
export const NOTIFY_BATCH_SIZE = 50;
