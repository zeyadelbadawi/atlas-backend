/**
 * The content-grant wire contract (master plan Phase 2 §D.2).
 *
 * ONE SHAPE, FOUR KINDS. A grant always answers the same questions — what
 * is this, may I have it, for how long, and what must the player show
 * while it plays — and the `kind` decides which payload field is
 * populated. The alternative (four endpoints, four shapes) would mean the
 * player had to know a lesson's type before it could ask about it, which
 * is exactly the information the curriculum response no longer carries.
 *
 * NOTHING HERE IS DURABLE. `fileUrl` and `video.url` are short-lived
 * signed URLs; `expiresAt` is when the whole grant stops being valid; and
 * the response is served `Cache-Control: private, no-store` so a shared
 * cache never holds a copy that outlives them (Phase 2 §I).
 */
import type { LessonCompletionRule, LessonContentKind } from '@prisma/client';
import type { ForensicWatermarkDisplay } from '../../forensic-watermark/dto/forensic-watermark.contract';

/**
 * Every machine-readable reason a content decision can carry. CLOSED
 * vocabulary: the frontend routes on these strings and
 * `content_access_log.reason` stores them, so a free-text reason would be
 * both an untranslatable UI state and an unqueryable log column.
 */
export const CONTENT_ACCESS_REASONS = [
  /** No session, or a session that is not for this academy. */
  'notAuthenticated',
  /** No enrollment at all, or one the academy membership no longer backs. */
  'notEnrolled',
  /** Enrolled once, but refunded / revoked / expired. */
  'accessEnded',
  /** The course is not published (or no longer is). */
  'courseUnavailable',
  /** The lesson is not published, or has no content to deliver. */
  'lessonUnavailable',
  /** Drip: the lesson has a future `available_at`. */
  'scheduled',
  /**
   * Sequential progression: the lesson is entitled and published, but an
   * earlier item in the CURRENT curriculum order is not finished yet, so it
   * is still locked. Derived from the same sequence the player sidebar draws
   * from — a reorder cannot leave the two disagreeing. Distinct from
   * `scheduled` (a clock) because the fix is "finish the previous item",
   * not "wait".
   */
  'locked',
  /** The learner is at their registered-device cap and this browser is not one of them. */
  'deviceLimit',
  /** Another device currently holds the learning lease. */
  'sessionConflict',
  /** The account is suspended. */
  'suspended',
  /** Too many grants in too short a window. */
  'rateLimited',
  /**
   * The lesson is reachable and the learner is entitled to it, but nobody
   * has authored its content yet (no `lesson_contents` row). Distinct from
   * `lessonUnavailable` so the player can say "no content yet" instead of
   * guessing "still processing". Only ever raised AFTER every entitlement
   * check has passed, so it discloses nothing to anyone who could not open
   * the lesson anyway.
   */
  'noContent',
  /** The lesson's video asset exists but has not finished processing. Same disclosure rule as `noContent`. */
  'processing',
  /**
   * The forensic watermark could not be issued, so no video credential was
   * signed (fail closed — docs/FORENSIC_WATERMARK.md). 503: transient.
   */
  'watermarkUnavailable',
] as const;
export type ContentAccessReason = (typeof CONTENT_ACCESS_REASONS)[number];

/**
 * The forensic watermark the player draws over every video
 * (docs/FORENSIC_WATERMARK.md). MANDATORY: `enabled` is true on every grant
 * that carries a playable video (hosted or YouTube embed) and an academy
 * cannot turn it off.
 *
 * A DETERRENT AND A TRACE, AND LABELLED AS SUCH (D1). It does not stop a
 * screen recording; it makes a re-published recording trace back to the
 * account and session it came from. Everything here is built server-side
 * from the viewer's own identity, so a client cannot blank it by lying.
 *
 * `text` is the legacy field (the previously deployed player draws it
 * verbatim) and now carries `CODE · masked identity`; the structured fields
 * (`code`, `kind`, `maskedIdentity`, `host`) are present whenever `enabled`.
 */
export interface ContentWatermarkContract extends Partial<ForensicWatermarkDisplay> {
  readonly enabled: boolean;
  readonly text: string;
}

/** What the browser must do to keep the single-session lease alive. */
export interface PlaybackLeaseContract {
  readonly leaseId: string;
  readonly ttlSeconds: number;
  readonly heartbeatSeconds: number;
}

export interface GrantedVideoContract {
  readonly format: 'hls' | 'mp4';
  readonly url: string;
  readonly posterUrl?: string;
  /** Always `false` (Phase 2 §I). Explicit so a test can assert it and a reviewer can see it. */
  readonly downloadable: false;
}

export interface GrantedResourceContract {
  readonly id: string;
  readonly title: string;
  /** Signed, short-lived. Absent for an external resource. */
  readonly url?: string;
  readonly externalUrl?: string;
}

/**
 * What protection is ACTUALLY in force for this grant (master plan AD-16).
 *
 * Replaces the earlier `'protected' | 'unprotected'` union, which could
 * not express either tier honestly: it was derived solely from whether
 * the content was an external embed, so Normal video, Premium video and a
 * protected PDF all reported the same word — and, after finding D-5,
 * `protected` was actively misleading for Premium, whose edge does not
 * re-check the session the token was issued to.
 *
 * Every field is read from the delivering adapter's `capabilities()`,
 * never assumed. A client renders these rather than a marketing label, so
 * a learner or an auditor can see exactly what is enforced. Note that on
 * two of these the Normal tier scores HIGHER than Premium; that is the
 * honest result and it is reported as such.
 */
export interface ContentProtectionReport {
  /** `null` for content with no hosted video (text, files, external embeds). */
  readonly tier: 'normal' | 'premium' | null;
  /** False only for an external embed Atlas does not host and cannot protect. */
  readonly signedUrl: boolean;
  /** Real lifetime of the credential in this response — never an optimistic figure (finding D-3). */
  readonly expiresInSeconds: number;
  /** Whether the DELIVERY EDGE re-checks the session on every request. `false` for Cloudflare Stream (D-5). */
  readonly boundToSession: boolean;
  readonly boundToDevice: boolean;
  /** Whether access can be cut off before the credential expires. */
  readonly revocableBeforeExpiry: boolean;
  readonly originRestricted: boolean;
  readonly watermark: boolean;
  readonly adaptiveBitrate: boolean;
  /** Always false. Neither tier has DRM — Cloudflare Stream does not offer it (D1). */
  readonly drm: false;
}

export interface ExternalEmbedContract {
  readonly provider: 'youtube';
  /** Exactly YouTube's 11-character id alphabet, validated server-side. */
  readonly videoId: string;
  /** Optional start offset carried from the URL's `t`/`start` parameter. */
  readonly startSeconds?: number;
}

export interface LessonContentGrantResponse {
  readonly lessonId: string;
  readonly courseId: string;
  readonly academyId: string;
  readonly title: string;
  readonly kind: LessonContentKind;
  readonly isPreview: boolean;
  readonly durationSeconds: number | null;
  readonly completionRule: LessonCompletionRule;
  /** The fraction of the video that must be watched before completion is allowed. Null when the rule is `manual`. */
  readonly minimumWatchedRatio: number | null;
  /**
   * Honest labelling (Phase 2 §E.3, AD-16) — see
   * `ContentProtectionReport`. An external embed Atlas does not host
   * reports `signedUrl: false` and a null tier, so the learner is told
   * the protection does not extend to it rather than left to assume it
   * does.
   */
  readonly protection: ContentProtectionReport;
  readonly bodyHtml?: string;
  readonly fileUrl?: string;
  readonly fileName?: string;
  readonly video?: GrantedVideoContract;
  readonly externalUrl?: string;
  /**
   * Present only when `externalUrl` is a supported YouTube link. The player
   * embeds from `videoId` alone — never from the raw URL — so this is the
   * only way an external address ever becomes a frame on the learner's
   * page. Absent for every other external URL, which stays a link-out.
   */
  readonly externalEmbed?: ExternalEmbedContract;
  readonly resources: readonly GrantedResourceContract[];
  readonly watermark: ContentWatermarkContract;
  /** Null for a preview opened without a session — there is nothing to lease. */
  readonly playbackLease: PlaybackLeaseContract | null;
  /** Where this learner left off, so the player can resume without a second round-trip. */
  readonly resumePositionSeconds: number;
  readonly expiresAt: string;
  /**
   * Academy offline work — whether the learner's browser may keep a copy
   * of THIS lesson's text to read without a connection, and until when.
   *
   * The server decides, never the client: only a `text` lesson (no video,
   * no file, no signed URL of any kind is needed to read it), only for a
   * signed-in learner reading through their own enrolment (never an
   * anonymous preview, never a staff preview). The client stores
   * `title` + `bodyHtml` only — never the rest of this grant — per user and
   * per academy origin, deletes it at `until`, at sign-out, and the moment
   * the server refuses this lesson again (revoked enrolment, unpublished
   * lesson). Video is never offered offline: its credentials are short-lived
   * and not device-bound, and there is no DRM.
   *
   * Optional so older clients are unaffected.
   */
  readonly offlineReading?: OfflineReadingPermission;
}

export interface OfflineReadingPermission {
  readonly allowed: boolean;
  /** ISO time after which a stored copy must be deleted. Null when not allowed. */
  readonly until: string | null;
}

/** How long a learner's browser may keep a text lesson for offline reading. */
export const OFFLINE_READING_TTL_SECONDS = 72 * 60 * 60;

/** 409 body when another device holds the lease — carries what the takeover dialog needs to name the other device. */
export interface SessionConflictDetails {
  readonly messageKey: 'errors.learning.sessionConflict';
  readonly details: {
    readonly deviceLabel: string | null;
    readonly since: string;
  };
}
