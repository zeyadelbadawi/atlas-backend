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
  /** B0-SUP-04 — optional WhatsApp number (E.164) and its country. */
  readonly phoneE164: string | null;
  readonly phoneCountry: string | null;
  /** B0-SUP-04 — each consent: given or not, when, and which wording version. */
  readonly contactConsent: PlatformContactConsentResponse;
  readonly marketingConsent: PlatformContactConsentResponse;
  readonly requesterRole: string | null;
  readonly subject: string | null;
  readonly studentBand: string | null;
  readonly preferredChannel: string | null;
  /** B0-ANL-04 — sanitised UTM values / referrer domain / landing template, or null. */
  readonly attribution: Record<string, string> | null;
}

export interface PlatformContactConsentResponse {
  readonly given: boolean;
  readonly at: string | null;
  readonly version: string | null;
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
    phoneE164: row.phoneE164,
    phoneCountry: row.phoneCountry,
    contactConsent: toConsent(row.contactConsentAt, row.contactConsentVersion),
    marketingConsent: toConsent(row.marketingConsentAt, row.marketingConsentVersion),
    requesterRole: row.requesterRole,
    subject: row.subject,
    studentBand: row.studentBand,
    preferredChannel: row.preferredChannel,
    attribution:
      row.attribution &&
      typeof row.attribution === 'object' &&
      !Array.isArray(row.attribution)
        ? (row.attribution as Record<string, string>)
        : null,
  };
}

function toConsent(
  at: Date | null,
  version: string | null,
): PlatformContactConsentResponse {
  return { given: at !== null, at: at ? at.toISOString() : null, version };
}
