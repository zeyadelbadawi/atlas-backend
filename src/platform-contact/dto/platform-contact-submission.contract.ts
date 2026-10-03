/**
 * Response contracts for the Platform Owner's marketing-enquiry inbox.
 * Matches `PlatformContactSubmission` (atlas frontend,
 * `features/platform/services/PlatformContactSubmissionService.ts`)
 * field-for-field.
 *
 * `ipHash` is deliberately NOT part of any response: it exists for
 * server-side abuse correlation, and an operator reading an enquiry has no
 * use for it.
 */
import type {
  PlatformContactSubmission,
  PlatformContactSubmissionStatus,
  PlatformContactTopic,
} from '@prisma/client';

export interface PlatformContactSubmissionResponse {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly organizationName: string | null;
  readonly topic: PlatformContactTopic;
  readonly message: string;
  readonly locale: string;
  readonly sourcePath: string | null;
  readonly status: PlatformContactSubmissionStatus;
  readonly userAgent: string | null;
  readonly readAt: string | null;
  readonly createdAt: string;
}

/** `GET platform/contact-submissions/summary` — counts per status. */
export interface PlatformContactSubmissionSummaryResponse {
  readonly total: number;
  readonly new: number;
  readonly read: number;
  readonly archived: number;
}

/**
 * `POST public/contact` — the ONE answer every accepted submission gets,
 * whether it was stored, deduplicated, or discarded as automated. It names
 * nothing (no id, no echo of the address), so it cannot be used to learn
 * whether an address has written before.
 */
export interface PlatformContactReceiptResponse {
  readonly received: true;
}

export function toPlatformContactSubmissionResponse(
  row: PlatformContactSubmission,
): PlatformContactSubmissionResponse {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    organizationName: row.organizationName,
    topic: row.topic,
    message: row.message,
    locale: row.locale,
    sourcePath: row.sourcePath,
    status: row.status,
    userAgent: row.userAgent,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
