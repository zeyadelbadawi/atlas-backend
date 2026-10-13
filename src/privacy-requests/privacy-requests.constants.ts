/**
 * B0-SEC-13 — request-based data deletion and data export (CF-11, DL-20 (b)).
 *
 * A person files a request from their profile, confirmed by a code emailed
 * to their verified address. A Platform Owner handles it from the
 * Privacy requests queue: an export opens a download window on the
 * person's profile; a deletion runs the existing Platform Owner deletion
 * path. No handling time is promised anywhere (no SLA is published).
 */
import type { PrivacyRequestStatus, PrivacyRequestType } from '@prisma/client';

export const PRIVACY_REQUEST_TYPES: readonly PrivacyRequestType[] = [
  'deletion',
  'export',
];

export const PRIVACY_REQUEST_STATUSES: readonly PrivacyRequestStatus[] = [
  'submitted',
  'in_progress',
  'completed',
  'rejected',
];

export const OPEN_STATUSES: readonly PrivacyRequestStatus[] = [
  'submitted',
  'in_progress',
];

/** How long a fulfilled export can be downloaded from the profile. */
export const EXPORT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The statuses a Platform Owner may set by hand; `completed` comes only from fulfilment. */
export const MANUAL_TRANSITIONS: Readonly<
  Record<PrivacyRequestStatus, readonly PrivacyRequestStatus[]>
> = {
  submitted: ['in_progress', 'rejected'],
  in_progress: ['rejected'],
  completed: [],
  rejected: [],
};

/** Bumped whenever the export bundle's shape changes. */
export const EXPORT_FORMAT_VERSION = 1;
