/**
 * LiveSessionAccessService — who may join a Live Session, and the
 * short-lived authorization that lets them.
 *
 * EVERY CONDITION IS CHECKED SERVER-SIDE, IN ORDER, AND ALL OF THEM MUST
 * HOLD. The product rule spells out the minimum; this is that rule, once,
 * as executable code:
 *
 *   1. authenticated                  (the guard already proved it)
 *   2. the session exists
 *   3. the caller belongs to the session's ACADEMY context — a student
 *      reaches it only through an enrollment whose `academy_id` matches
 *      the session's, which is what makes cross-academy access fail even
 *      when a valid session id from another tenant is supplied
 *   4. enrolled in THAT course, with an enrollment that is actually active
 *   5. the session is published and not cancelled
 *   6. the add-on is installed, enabled and entitled
 *   7. the session is joinable NOW, by its own schedule
 *   8. the academy's provider connection is healthy
 *
 * CHANGING AN ID IN THE URL CHANGES NOTHING. The session id is the only
 * thing the caller supplies; the academy, course and organization are all
 * read FROM that session server-side, never accepted from the request. A
 * student who substitutes another academy's session id fails at (4),
 * because no enrollment of theirs matches it — and RLS independently
 * refuses to return the row at all.
 *
 * WHAT THE JOIN AUTHORIZATION IS, AND IS NOT. Atlas never hands out a
 * provider credential or a raw meeting URL. It mints a single-use,
 * short-lived grant bound to (session, user, role), stores only its hash,
 * and the client redeems it to obtain the provider signature needed by the
 * embedded SDK. A captured link is useless once redeemed or expired, and
 * is bound to the person it was issued for.
 *
 * WHAT IT HONESTLY DOES NOT DO: stop a determined participant from
 * screen-recording, photographing, or narrating the session elsewhere. No
 * software can, and claiming otherwise would be a lie. What it makes
 * non-transferable is the JOIN itself, which is the part that is actually
 * enforceable.
 */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  AddOnAccessService,
  LIVE_SESSIONS_ADD_ON_KEY,
  LIVE_SESSIONS_FEATURE_KEY,
} from './add-on-access.service';

export const LIVE_SESSION_NOT_JOINABLE_CODE = 'LIVE_SESSION_NOT_JOINABLE';

/**
 * How long before the scheduled start a participant may enter, and how
 * long after the scheduled end the room stays open.
 *
 * Defaults, not hardcoded policy: a session that runs over should not
 * eject everyone at the stroke of the end time, and joining a few minutes
 * early is normal classroom behaviour. Both are single named constants so
 * a future per-academy setting has exactly one place to override.
 */
export const JOIN_WINDOW_BEFORE_START_MS = 15 * 60 * 1000;
export const JOIN_WINDOW_AFTER_END_MS = 30 * 60 * 1000;

/** How long a minted grant is valid. Deliberately short — it is redeemed immediately. */
export const JOIN_GRANT_TTL_MS = 2 * 60 * 1000;

export type JoinRefusalReason =
  | 'not_enrolled'
  | 'wrong_academy'
  | 'not_published'
  | 'cancelled'
  | 'too_early'
  | 'too_late'
  | 'provider_unavailable'
  | 'add_on_unavailable';

export interface JoinAuthorization {
  /** The opaque single-use token. Returned once, never stored in the clear. */
  readonly token: string;
  readonly expiresAt: Date;
  /** The deterministic identity the provider will echo back on webhooks. */
  readonly participantKey: string;
  readonly role: 'host' | 'attendee';
}

/** Hashing matches the refresh-token precedent: store the digest, never the secret. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class LiveSessionAccessService {
  constructor(private readonly addOnAccessService: AddOnAccessService) {}

  /**
   * Whether `userId` may join `liveSessionId` right now.
   *
   * Returns a reason rather than throwing, so the session screen can
   * explain "starts in 20 minutes" instead of showing a dead button.
   * {@link authorizeJoin} is the enforcing counterpart.
   */
  async describeJoinEligibility(
    tx: Prisma.TransactionClient,
    args: {
      readonly liveSessionId: string;
      readonly userId: string;
      readonly organizationId: string;
      readonly now?: Date;
    },
  ): Promise<{ joinable: boolean; reason?: JoinRefusalReason; isHost: boolean }> {
    const now = args.now ?? new Date();

    const session = await tx.liveSession.findUnique({
      where: { id: args.liveSessionId },
      select: {
        id: true,
        academyId: true,
        courseId: true,
        status: true,
        hostUserId: true,
        scheduledStartAt: true,
        scheduledEndAt: true,
        providerMeetingId: true,
      },
    });

    // Indistinguishable from "exists but not yours" on purpose — a 404
    // here must not become an oracle telling an attacker which session ids
    // are real in other tenants.
    if (!session) throw new NotFoundException({ messageKey: 'errors.notFound' });

    const isHost = session.hostUserId === args.userId;

    // The add-on must be usable for the tenant that OWNS the session —
    // reported here so the screen can say "this add-on is disabled"
    // rather than a generic refusal, and enforced again in
    // `authorizeJoin` where it actually matters.
    const addOnState = await this.addOnAccessService.describe(
      tx,
      args.organizationId,
      LIVE_SESSIONS_ADD_ON_KEY,
      LIVE_SESSIONS_FEATURE_KEY,
    );
    if (!addOnState.usable) {
      return { joinable: false, reason: 'add_on_unavailable', isHost };
    }

    if (session.status === 'cancelled') {
      return { joinable: false, reason: 'cancelled', isHost };
    }
    if (session.status === 'draft') {
      return { joinable: false, reason: 'not_published', isHost };
    }

    // ENROLLMENT IS THE STUDENT'S ONLY ROUTE IN, and it is matched on BOTH
    // course and academy. The academy match is what defeats a
    // cross-academy id substitution: an enrollment in another academy's
    // course of the same name is not this session's course.
    if (!isHost) {
      const enrollment = await tx.enrollment.findFirst({
        where: {
          studentId: args.userId,
          courseId: session.courseId,
          academyId: session.academyId,
          // `enrolled` and `completed` are the only states that mean the
          // student genuinely has this course. `available`/`pending`/
          // `unavailable` describe the catalog offer, not a relationship.
          status: { in: ['enrolled', 'completed'] },
        },
        select: { id: true },
      });
      if (!enrollment) {
        return { joinable: false, reason: 'not_enrolled', isHost };
      }
    }

    // The provider connection belongs to the session's academy, and a
    // session cannot be entered while it is unhealthy — the UI says
    // "reconnect required" rather than failing at the provider.
    const connection = await tx.academyLiveProviderConnection.findUnique({
      where: { academyId: session.academyId },
      select: { status: true },
    });
    if (!connection || connection.status !== 'connected') {
      return { joinable: false, reason: 'provider_unavailable', isHost };
    }

    const opensAt = session.scheduledStartAt.getTime() - JOIN_WINDOW_BEFORE_START_MS;
    const closesAt = session.scheduledEndAt.getTime() + JOIN_WINDOW_AFTER_END_MS;

    // A session already marked `live` is joinable regardless of the clock:
    // the host started it, which is a stronger signal than the schedule.
    if (session.status !== 'live') {
      if (now.getTime() < opensAt)
        return { joinable: false, reason: 'too_early', isHost };
      if (now.getTime() > closesAt)
        return { joinable: false, reason: 'too_late', isHost };
    }

    if (session.status === 'ended' && now.getTime() > closesAt) {
      return { joinable: false, reason: 'too_late', isHost };
    }

    return { joinable: true, isHost };
  }

  /**
   * Verifies eligibility and mints the single-use grant.
   *
   * The participant identity is created here, ONCE per (session, user),
   * and reused on every subsequent join — which is what makes a student
   * who joins three times produce three intervals against ONE identity
   * rather than three unrelated participants.
   */
  async authorizeJoin(
    tx: Prisma.TransactionClient,
    args: {
      readonly liveSessionId: string;
      readonly userId: string;
      readonly organizationId: string;
      readonly now?: Date;
    },
  ): Promise<JoinAuthorization> {
    const now = args.now ?? new Date();

    // The add-on gate, enforced (not merely described) before anything is
    // minted. A tenant whose add-on is disabled cannot obtain a grant even
    // with a perfectly valid enrollment.
    await this.addOnAccessService.assertUsable(tx, args.organizationId);

    const eligibility = await this.describeJoinEligibility(tx, args);
    if (!eligibility.joinable) {
      throw new ForbiddenException({
        messageKey: 'errors.liveSessions.notJoinable',
        code: LIVE_SESSION_NOT_JOINABLE_CODE,
        details: { reason: eligibility.reason },
      });
    }

    const session = await tx.liveSession.findUniqueOrThrow({
      where: { id: args.liveSessionId },
      select: { academyId: true },
    });

    const role = eligibility.isHost ? ('host' as const) : ('attendee' as const);

    // One stable identity per (session, user). `upsert` rather than
    // create-if-missing so two simultaneous joins cannot mint two keys for
    // the same person — the unique constraint decides, not a read.
    const participantKey = `atlas_${randomBytes(16).toString('hex')}`;
    const participant = await tx.liveSessionParticipant.upsert({
      where: {
        liveSessionId_userId: {
          liveSessionId: args.liveSessionId,
          userId: args.userId,
        },
      },
      update: {},
      create: {
        liveSessionId: args.liveSessionId,
        userId: args.userId,
        academyId: session.academyId,
        participantKey,
        role,
      },
      select: { participantKey: true },
    });

    // The token is returned once and never stored; only its digest is
    // persisted, so a database reader cannot replay a live grant.
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + JOIN_GRANT_TTL_MS);

    await tx.liveSessionJoinGrant.create({
      data: {
        liveSessionId: args.liveSessionId,
        userId: args.userId,
        academyId: session.academyId,
        tokenHash: hashToken(token),
        role,
        expiresAt,
      },
    });

    return { token, expiresAt, participantKey: participant.participantKey, role };
  }

  /**
   * Redeems a grant exactly once.
   *
   * The conditional UPDATE is the whole mechanism: it matches only a grant
   * that is unredeemed and unexpired AND belongs to this user, and reports
   * how many rows it changed. Two simultaneous redemptions of the same
   * token produce one success and one refusal, decided by the database
   * rather than by a read-then-write in application code.
   */
  async redeemGrant(
    tx: Prisma.TransactionClient,
    args: { readonly token: string; readonly userId: string; readonly now?: Date },
  ): Promise<{ liveSessionId: string; role: string }> {
    const now = args.now ?? new Date();
    const tokenHash = hashToken(args.token);

    const updated = await tx.liveSessionJoinGrant.updateMany({
      where: {
        tokenHash,
        userId: args.userId,
        redeemedAt: null,
        expiresAt: { gt: now },
      },
      data: { redeemedAt: now },
    });

    if (updated.count !== 1) {
      throw new ForbiddenException({
        messageKey: 'errors.liveSessions.grantInvalid',
        code: LIVE_SESSION_NOT_JOINABLE_CODE,
      });
    }

    const grant = await tx.liveSessionJoinGrant.findUniqueOrThrow({
      where: { tokenHash },
      select: { liveSessionId: true, role: true },
    });

    return grant;
  }
}
