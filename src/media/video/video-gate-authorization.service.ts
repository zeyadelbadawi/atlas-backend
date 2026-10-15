/**
 * Workstream D — the Normal tier's delivery Worker asks Atlas, with a short
 * bounded cache, whether a playback token it already verified is STILL
 * honoured. This is what makes `revocableBeforeExpiry` true.
 *
 * THE PROBLEM. A gate token carries its own expiry (≤ 10 minutes) and the
 * Worker checked signature, object key and expiry only — so a learner whose
 * device was removed, whose session was revoked, whose account was deleted,
 * whose enrollment ended or whose membership was blocked kept streaming
 * until the token died. The earlier fix was a PUSH: Atlas POSTed revoked
 * session ids to a "revocation endpoint" that would feed a KV denylist. No
 * such receiver ever existed (the Worker answers `405` to every POST), so
 * the endpoint stayed unset and the capability was honestly reported false.
 *
 * WHY A PULL. Every revocation Atlas performs already lands in durable
 * state this service can read — `refresh_tokens.revoked_at` (sign-out,
 * revoke-session, sign-out-others, credential change, takeover, device
 * removal, membership block, account deletion), `student_devices.revoked_at`,
 * `users.status`, `enrollments` and `academy_students`. Re-reading THAT is a
 * single source of truth with no second list to keep in sync, no missed
 * caller, and no Workers KV dependency (KV's free plan allows 100 000 reads
 * and 1 000 writes a day and is eventually consistent for "60 seconds or
 * more" — an unbounded revocation latency and a hard daily quota that a
 * fail-closed gate would turn into an outage). The Worker caches an answer
 * for at most `GATE_AUTHZ_MAX_CACHE_SECONDS`, so revocation reaches every
 * edge location within that bound — explicit, and not a propagation guess.
 *
 * ATLAS STAYS THE AUTHORITY (AD-1), AND THIS ONLY NARROWS. The token is
 * verified with Atlas's own signing secret before anything is read, and
 * the checks re-run the subset of `LessonContentService.getContent`'s
 * conditions that can CHANGE after a grant: identity still active, session
 * still live, device still registered, enrollment and membership still
 * current, course and lesson still published, the lesson still pointing at
 * these bytes. Nothing here can say yes to a request the original grant
 * would have refused.
 *
 * RLS-RESPECTING. Every read runs in the token's user's own context (or
 * none, for an anonymous preview token) — exactly the context the grant
 * itself ran in — so `can_access_lesson()` and every other policy applies.
 * Academy and course come from SIGNED claims and are cross-checked against
 * the object key and the database rows, so a token for one tenant or one
 * course can never be re-scoped to another.
 *
 * AUTHENTICATED CALLER. Only the Worker may ask: each call is HMAC-signed
 * over `timestamp.rawBody` with `BASIC_VIDEO_GATE_AUTHZ_SECRET` (a secret
 * distinct from the token-signing one, so the Worker can sign these calls
 * and still never mint a playback token), with a ±60 s freshness window.
 * A replayed call inside that window only re-asks a read-only question.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { BasicVideoConfig } from '../../config/configuration';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { isEnrollmentActive } from '../../learning/services/learning-access.util';
import { LearningMetricsService } from '../../observability/metrics/learning-metrics.service';
import { BasicVideoProvider, type GateClaims } from './basic-video.provider';

/**
 * The longest any edge location may reuse an answer. THIS IS THE
 * REVOCATION BOUND: a revocation committed at T stops playback everywhere
 * by T + 30 s (plus one in-flight response already streaming). The Worker
 * clamps to the same ceiling independently, so neither side alone can
 * widen it.
 */
export const GATE_AUTHZ_MAX_CACHE_SECONDS = 30;

/** How far a call's timestamp may drift from the API's clock. */
export const GATE_AUTHZ_MAX_SKEW_SECONDS = 60;

/** Header names — the contract with `deploy/video-gate-worker/src/authz.js`. */
export const GATE_AUTHZ_TIMESTAMP_HEADER = 'x-atlas-gate-timestamp';
export const GATE_AUTHZ_SIGNATURE_HEADER = 'x-atlas-gate-signature';

/** The token's "nobody" placeholders, as `LessonContentService.buildGrant` writes them. */
const ANONYMOUS = 'anonymous';

/** Every reason a token stops being honoured. Safe to return to the Worker and log: none carries an identifier. */
export type GateAuthzDenyReason =
  | 'invalid_token'
  | 'key_mismatch'
  | 'unscoped_token'
  | 'academy_mismatch'
  | 'course_mismatch'
  | 'lesson_unavailable'
  | 'asset_mismatch'
  | 'preview_ended'
  | 'account_inactive'
  | 'session_revoked'
  | 'device_revoked'
  | 'access_ended';

export type GateAuthzDecision =
  | { readonly allow: true; readonly ttlSeconds: number }
  | {
      readonly allow: false;
      readonly reason: GateAuthzDenyReason;
      readonly ttlSeconds: number;
    };

@Injectable()
export class VideoGateAuthorizationService {
  private readonly logger = new Logger(VideoGateAuthorizationService.name);
  private readonly config: BasicVideoConfig;

  constructor(
    configService: ConfigService,
    private readonly gate: BasicVideoProvider,
    private readonly tenancy: TenancyContextService,
    private readonly metrics: LearningMetricsService,
  ) {
    this.config = configService.getOrThrow<BasicVideoConfig>('basicVideo');
  }

  /** The endpoint exists only when the Worker can call it and Atlas can verify tokens. */
  get isEnabled(): boolean {
    return Boolean(this.config.gateAuthzSecret && this.gate.isConfigured());
  }

  /**
   * Verifies the Worker's HMAC over `${timestamp}.${rawBody}`.
   *
   * Constant-time comparison after a length check (`timingSafeEqual` throws
   * on unequal lengths, and an attacker must not turn that into a 500).
   */
  verifyCaller(
    timestamp: string | undefined,
    signature: string | undefined,
    rawBody: string,
    nowMs: number = Date.now(),
  ): boolean {
    const secret = this.config.gateAuthzSecret;
    if (!secret || !timestamp || !signature) return false;
    if (!/^\d{1,12}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) return false;
    if (Math.abs(nowMs / 1000 - Number(timestamp)) > GATE_AUTHZ_MAX_SKEW_SECONDS) {
      return false;
    }
    const expected = createHmac('sha256', secret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  /**
   * Whether `token` is still honoured for `objectKey`. Never throws for a
   * refusal — a database failure DOES throw, and the controller turns it
   * into a 5xx the Worker treats as "cannot authorize" (fail closed).
   */
  async authorize(
    token: string,
    objectKey: string,
    now: Date = new Date(),
  ): Promise<GateAuthzDecision> {
    const decision = await this.decide(token, objectKey, now);
    this.metrics.recordGateAuthorization(decision.allow ? 'allow' : decision.reason);
    return decision;
  }

  private async decide(
    token: string,
    objectKey: string,
    now: Date,
  ): Promise<GateAuthzDecision> {
    // Atlas's own signature first: nothing below reads an unauthenticated claim.
    const verified = this.gate.verifyGateToken(token, now);
    if (!verified.valid || !verified.claims) return deny('invalid_token');
    const claims = verified.claims;
    if (!isGateClaims(claims)) return deny('invalid_token');
    if (claims.k !== objectKey) return deny('key_mismatch');
    // A token minted before Workstream D carries no scope; there is no
    // lesson to re-check, so it is not honoured. (None exist in production:
    // the tier has never been switched on there.)
    if (!claims.a || !claims.c || !claims.l) return deny('unscoped_token');

    // The object key is built from verified context
    // (`academies/<academy>/[courses/<course>/]<asset>.mp4`); a signed
    // claim that disagrees with it is refused before any database read.
    if (!objectKey.startsWith(`academies/${claims.a}/`)) return deny('academy_mismatch');
    const courseSegment = /^academies\/[^/]+\/courses\/([^/]+)\//.exec(objectKey);
    if (courseSegment && courseSegment[1] !== claims.c) return deny('course_mismatch');

    // Never cache past the token's own expiry.
    const ttlSeconds = Math.max(
      1,
      Math.min(GATE_AUTHZ_MAX_CACHE_SECONDS, Math.floor(claims.e - now.getTime() / 1000)),
    );
    const anonymous = claims.u === ANONYMOUS;
    const run = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
      anonymous
        ? this.tenancy.runWithoutContext(work)
        : this.tenancy.runInUserContext(claims.u, work);

    const scoped = claims as Required<GateClaims>;
    const reason = await run((tx) => this.refusalFor(tx, scoped, anonymous, now));
    if (reason) {
      this.logger.log(
        // Identifiers truncated, as everywhere else on this path; never the token.
        { event: 'video_gate.authz.denied', reason, user: claims.u.slice(0, 8) },
        'Video gate re-authorization refused a token.',
      );
      return { allow: false, reason, ttlSeconds };
    }
    return { allow: true, ttlSeconds };
  }

  /**
   * The first condition that no longer holds, or null when the grant still
   * stands. The person is checked before the content: once an entitlement
   * ends, RLS hides the lesson's asset from that user, and "your session
   * was revoked" is the true reason where "asset mismatch" would only be
   * its symptom.
   */
  private async refusalFor(
    tx: Prisma.TransactionClient,
    claims: Required<GateClaims>,
    anonymous: boolean,
    now: Date,
  ): Promise<GateAuthzDenyReason | null> {
    let staff = false;
    let entitled = false;
    if (anonymous) {
      // An anonymous token is a preview grant and nothing else.
      if (claims.s !== ANONYMOUS || claims.d !== ANONYMOUS) return 'invalid_token';
    } else {
      // --- identity (condition 7) -----------------------------------------
      const account = await tx.user.findUnique({
        where: { id: claims.u },
        select: { status: true },
      });
      if (!account || account.status !== 'active') return 'account_inactive';

      // --- session --------------------------------------------------------
      // The DURABLE record, not the Redis access-token denylist: that
      // list's entries live for the access-token TTL (15 min) and a
      // playback token may outlive it. A session is live while any member
      // of its rotation family is unrevoked and unexpired — exactly
      // `SessionRevocationService`'s own authoritative fallback. Every
      // session-ending path (sign-out, revoke, sign-out-others, credential
      // change, takeover, device removal, block, deletion) revokes these rows.
      if (claims.s === ANONYMOUS) return 'session_revoked';
      const liveRows = await tx.refreshToken.count({
        where: {
          userId: claims.u,
          sessionId: claims.s,
          revokedAt: null,
          expiresAt: { gt: now },
        },
      });
      if (liveRows === 0) return 'session_revoked';

      if (claims.d === ANONYMOUS) {
        // --- staff preview: no device, no enrollment ----------------------
        staff = await this.isStaffPreviewer(tx, claims.u, claims.c, claims.a);
        if (!staff) return 'device_revoked';
      } else {
        // --- device -------------------------------------------------------
        const device = await tx.studentDevice.findFirst({
          where: { id: claims.d, userId: claims.u, academyId: claims.a, revokedAt: null },
          select: { id: true },
        });
        if (!device) return 'device_revoked';

        // --- enrollment + membership (condition 3) ------------------------
        // Not yet a refusal on its own: an open preview lesson needs no
        // enrollment, exactly as at grant time. Decided below.
        const [enrollment, membership] = await Promise.all([
          tx.enrollment.findUnique({
            where: { studentId_courseId: { studentId: claims.u, courseId: claims.c } },
            select: { status: true, revokedAt: true, expiresAt: true, academyId: true },
          }),
          tx.academyStudent.findFirst({
            where: { academyId: claims.a, userId: claims.u },
            select: { status: true, blockedAt: true },
          }),
        ]);
        entitled = Boolean(
          enrollment &&
          enrollment.academyId === claims.a &&
          isEnrollmentActive(enrollment, now) &&
          membership &&
          membership.status === 'active' &&
          !membership.blockedAt,
        );
      }
    }

    // --- the content: still these bytes, in this course, in this academy --
    const [lesson, course] = await Promise.all([
      tx.courseLesson.findFirst({
        where: { id: claims.l, courseId: claims.c },
        select: {
          status: true,
          isPreview: true,
          videoAsset: {
            select: {
              academyId: true,
              provider: true,
              providerId: true,
              processingStatus: true,
            },
          },
        },
      }),
      tx.course.findUnique({
        where: { id: claims.c },
        select: { academyId: true, status: true },
      }),
    ]);
    // Zero rows is RLS refusing as often as it is a missing row — and
    // either way there is nothing left to deliver.
    if (!lesson || !course)
      return entitled || staff || anonymous ? 'lesson_unavailable' : 'access_ended';
    if (course.academyId !== claims.a) return 'academy_mismatch';
    const published = lesson.status === 'published' && course.status === 'published';
    const openPreview = lesson.isPreview && published;
    // A learner whose entitlement ended no longer sees the asset through
    // RLS; say why rather than reporting the symptom.
    if (!anonymous && !staff && !entitled && !openPreview) return 'access_ended';
    const asset = lesson.videoAsset;
    if (
      !asset ||
      asset.provider !== 'r2_worker' ||
      asset.providerId !== claims.k ||
      asset.academyId !== claims.a ||
      asset.processingStatus !== 'ready'
    ) {
      return 'asset_mismatch';
    }

    if (anonymous) return openPreview ? null : 'preview_ended';
    if (staff) return null;
    if (openPreview) return null;
    if (!entitled) return 'access_ended';
    // --- publication (conditions 4–5) ---------------------------------------
    return published ? null : 'lesson_unavailable';
  }

  /** Same rule as `LessonContentService.isStaffPreviewer`, evaluated now rather than at grant time. */
  private async isStaffPreviewer(
    tx: Prisma.TransactionClient,
    userId: string,
    courseId: string,
    academyId: string,
  ): Promise<boolean> {
    const [instructor, member] = await Promise.all([
      tx.courseInstructor.findFirst({
        where: { courseId, userId },
        select: { userId: true },
      }),
      tx.academyMember.findFirst({
        where: {
          academyId,
          userId,
          status: 'active',
          role: { in: ['owner', 'administrator', 'manager'] },
        },
        select: { id: true },
      }),
    ]);
    return Boolean(instructor ?? member);
  }
}

function deny(reason: GateAuthzDenyReason): GateAuthzDecision {
  // A malformed or mis-scoped token never becomes valid; the Worker may
  // cache that answer for the full window.
  return { allow: false, reason, ttlSeconds: GATE_AUTHZ_MAX_CACHE_SECONDS };
}

function isGateClaims(claims: GateClaims): claims is GateClaims {
  const nonEmpty = (value: unknown) => typeof value === 'string' && value.length > 0;
  const optional = (value: unknown) => value === undefined || nonEmpty(value);
  return (
    nonEmpty(claims.k) &&
    nonEmpty(claims.u) &&
    nonEmpty(claims.s) &&
    nonEmpty(claims.d) &&
    typeof claims.e === 'number' &&
    optional(claims.a) &&
    optional(claims.c) &&
    optional(claims.l)
  );
}
