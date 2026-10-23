/**
 * TASK 7 — the limits and windows of the Atlas marketing contact form.
 *
 * One file, so the DTO, the anti-abuse checks and the frontend's mirrored
 * client validation (`MarketingContactSection`) have one place to agree
 * with. A change here is a change to the public contract.
 */
import type {
  PlatformContactSubmissionStatus,
  PlatformContactTopic,
} from '@prisma/client';

import { clientIpPrefixTracker } from '../common/security/client-ip-throttler.guard';

export const PLATFORM_CONTACT_TOPICS = [
  'sales',
  'support',
  'partnership',
  'other',
  'founding',
] as const satisfies readonly PlatformContactTopic[];

export const PLATFORM_CONTACT_STATUSES = [
  'new',
  'read',
  'archived',
] as const satisfies readonly PlatformContactSubmissionStatus[];

export const PLATFORM_CONTACT_LOCALES = ['en', 'ar'] as const;

export const PLATFORM_CONTACT_LIMITS = {
  nameMin: 2,
  nameMax: 200,
  emailMax: 320,
  organizationMax: 200,
  messageMin: 10,
  messageMax: 5000,
  sourcePathMax: 512,
  userAgentMax: 512,
  honeypotMax: 200,
} as const;

/**
 * B0-SUP-04 — the consent wording VERSION stamped on an enquiry when a
 * consent box was ticked. The SERVER stamps it (the client sends only
 * true/false), so a stored consent always names the wording this build
 * shows. The frontend mirrors it (`CONTACT_CONSENT_WORDING_VERSION`,
 * MarketingContactSection) — change both together. `draft1`: the wording is
 * a DRAFT pending counsel; the approved text ships as a new version.
 */
export const CONTACT_CONSENT_WORDING_VERSION = 'contact-consent-2026-10-draft1';

/**
 * B0-SUP-04 — optional qualification answers (CHECK-listed in the migration),
 * kept only for the topics below. B2: a Founding Academies application is a
 * sales conversation, so it carries the same answers.
 */
export const PLATFORM_CONTACT_QUALIFIED_TOPICS: readonly PlatformContactTopic[] = [
  'sales',
  'founding',
];
export const PLATFORM_CONTACT_REQUESTER_ROLES = [
  'academy_owner',
  'teacher',
  'centre_manager',
  'other',
] as const;
export const PLATFORM_CONTACT_STUDENT_BANDS = [
  'under_50',
  '50_200',
  '200_1000',
  'over_1000',
] as const;
export const PLATFORM_CONTACT_PREFERRED_CHANNELS = [
  'whatsapp',
  'email',
  'phone_call',
] as const;
export const PLATFORM_CONTACT_SUBJECT_MAX = 120;

/**
 * A person needs more than this to type a name, an address and a message.
 * A submission that arrives faster is treated as automated and silently
 * discarded (the caller still gets the normal success answer).
 */
export const PLATFORM_CONTACT_MIN_FILL_MS = 3_000;

/** Identical address + message within this window is stored once. */
export const PLATFORM_CONTACT_DEDUPE_TTL_SECONDS = 600;

/**
 * Per-client route throttle: 5 submissions per 10 minutes, keyed per IPv4
 * address or per IPv6 /64 (`clientIpPrefixTracker`).
 */
export const PLATFORM_CONTACT_THROTTLE = {
  limit: 5,
  ttl: 600_000,
  getTracker: clientIpPrefixTracker,
} as const;

/** Audit actions this module writes — see `AuditLogWriterService`. */
export const PLATFORM_CONTACT_AUDIT_ACTIONS = {
  statusChanged: 'platform.contact_submission.status_changed',
  deleted: 'platform.contact_submission.deleted',
  retentionPurged: 'platform.contact_submission.retention_purged',
} as const;

/**
 * B0-SUP-04 — enquiry retention sweep: one daily job on its own queue (the
 * `SecurityMaintenanceScheduler` shape). Job ids never contain `:`.
 */
export const PLATFORM_CONTACT_RETENTION_QUEUE = 'platform-contact-retention';
export const PLATFORM_CONTACT_RETENTION_JOB = 'sweep';
export const PLATFORM_CONTACT_RETENTION_REPEAT_JOB_ID =
  'platform-contact-retention-repeat';
export const PLATFORM_CONTACT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Most enquiries one run deletes; anything older waits for the next day. */
export const PLATFORM_CONTACT_RETENTION_MAX_PER_RUN = 500;

export const PLATFORM_CONTACT_AUDIT_TARGET = 'platform_contact_submission';

/** The communication entity the new-enquiry notification is emitted for (its id is the enquiry's). */
export const PLATFORM_CONTACT_NOTIFICATION = {
  key: 'platform.contact_submission.received',
  entityType: 'platform_contact_submission',
} as const;
