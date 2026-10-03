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

export const PLATFORM_CONTACT_TOPICS = [
  'sales',
  'support',
  'partnership',
  'other',
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
 * A person needs more than this to type a name, an address and a message.
 * A submission that arrives faster is treated as automated and silently
 * discarded (the caller still gets the normal success answer).
 */
export const PLATFORM_CONTACT_MIN_FILL_MS = 3_000;

/** Identical address + message within this window is stored once. */
export const PLATFORM_CONTACT_DEDUPE_TTL_SECONDS = 600;

/** Per-IP route throttle: 5 submissions per 10 minutes. */
export const PLATFORM_CONTACT_THROTTLE = { limit: 5, ttl: 600_000 } as const;

/** Audit actions this module writes — see `AuditLogWriterService`. */
export const PLATFORM_CONTACT_AUDIT_ACTIONS = {
  statusChanged: 'platform.contact_submission.status_changed',
  deleted: 'platform.contact_submission.deleted',
} as const;

export const PLATFORM_CONTACT_AUDIT_TARGET = 'platform_contact_submission';

/** The communication entity the new-enquiry notification is emitted for (its id is the enquiry's). */
export const PLATFORM_CONTACT_NOTIFICATION = {
  key: 'platform.contact_submission.received',
  entityType: 'platform_contact_submission',
} as const;
