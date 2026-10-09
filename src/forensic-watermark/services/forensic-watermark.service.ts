/**
 * ForensicWatermarkService — issues the per-viewer, per-session code every
 * player draws over a video, and keeps its record current
 * (docs/FORENSIC_WATERMARK.md).
 *
 * WHERE IT IS CALLED. From inside the transaction that is already deciding
 * the grant (`LessonContentService`), or in a transaction of its own (the
 * live-class redeem). Either way the transaction runs in the VIEWER's own
 * user context — or in none, for an anonymous course preview — because the
 * database admits a record only for the caller themself
 * (`forensic_watermark_issue`), and the phone number can only be read in the
 * owner's own context (`user_phones` is self-only).
 *
 * FAIL CLOSED. Every failure here is a `WatermarkIssuanceError`. Callers
 * must refuse to hand out a playable credential when they get one: a video
 * that plays unmarked is exactly the gap this feature closes.
 *
 * WHAT IT NEVER DOES. Log a name, an email or a phone number; return the
 * snapshot; let a viewer read any record (the functions return only the
 * caller's own code).
 */
import { Injectable, Logger } from '@nestjs/common';
import type { ForensicWatermarkSurface, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { hashDeviceCookie } from '../../tenancy/services/student-device.service';
import { deriveDeviceLabel } from '../../identity/utils/request-metadata.util';
import { RedisService } from '../../redis/redis.service';
import { formatWatermarkCode, generateWatermarkCode } from '../utils/watermark-code.util';
import { maskEmail } from '../utils/viewer-display.util';
import {
  WatermarkSnapshotCipher,
  type WatermarkIdentitySnapshot,
} from './watermark-snapshot-cipher.service';
import type { ForensicWatermarkDisplay } from '../dto/forensic-watermark.contract';

/** Who is watching, as the request established it — never from a body. */
export interface WatermarkViewer {
  readonly userId: string | null;
  /** The refresh-token family (`sid`). */
  readonly sessionId: string | null;
  readonly deviceId?: string | null;
  /** The raw `atlas_device` cookie; only its hash is stored. */
  readonly deviceCookie?: string | null;
  /** The registered device's own label, when the grant resolved one. */
  readonly deviceLabel?: string | null;
  readonly clientIp?: string | null;
  readonly country?: string | null;
  readonly userAgent?: string | null;
  /** The host the request arrived on — shown with "Preview" to an anonymous visitor. */
  readonly requestHost?: string | null;
}

/** What is being shown. */
export interface WatermarkTarget {
  readonly surface: ForensicWatermarkSurface;
  readonly organizationId?: string | null;
  readonly academyId: string;
  readonly courseId?: string | null;
  readonly lessonId?: string | null;
  readonly liveSessionId?: string | null;
  readonly labels?: Partial<WatermarkIdentitySnapshot['target']>;
}

export interface IssuedWatermark {
  readonly display: ForensicWatermarkDisplay;
  /** Normalised (no dash). */
  readonly code: string;
  readonly reused: boolean;
}

export class WatermarkIssuanceError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'WatermarkIssuanceError';
  }
}

/** Code draws before giving up — a collision at all is a ~1-in-10¹³ event. */
const MAX_CODE_ATTEMPTS = 5;
/** The heartbeat touches a record at most this often (Redis gate, then the DB's own). */
const TOUCH_INTERVAL_SECONDS = 60;

@Injectable()
export class ForensicWatermarkService {
  private readonly logger = new Logger(ForensicWatermarkService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly cipher: WatermarkSnapshotCipher,
    private readonly redisService: RedisService,
  ) {}

  /**
   * Issues (or reuses) the code for this viewer + session + target, inside
   * the caller's transaction. That transaction MUST be in the viewer's own
   * user context, or in none for an anonymous preview.
   */
  async issueInTransaction(
    tx: Prisma.TransactionClient,
    viewer: WatermarkViewer,
    target: WatermarkTarget,
  ): Promise<IssuedWatermark> {
    try {
      const sessionKey = this.sessionKey(viewer, target);
      const identity = viewer.userId ? await this.readIdentity(tx, viewer) : null;
      const deviceCookieHash = viewer.deviceCookie
        ? hashDeviceCookie(viewer.deviceCookie)
        : null;
      const deviceLabel =
        viewer.deviceLabel ?? deriveDeviceLabel(viewer.userAgent ?? undefined) ?? null;

      for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
        const candidate = generateWatermarkCode();
        const snapshot = identity
          ? this.cipher.encrypt(
              {
                ...identity.snapshot,
                target: {
                  organizationName: target.labels?.organizationName ?? null,
                  academyName: target.labels?.academyName ?? null,
                  courseTitle: target.labels?.courseTitle ?? null,
                  lessonTitle: target.labels?.lessonTitle ?? null,
                  liveSessionTitle: target.labels?.liveSessionTitle ?? null,
                },
              },
              candidate,
            )
          : null;

        const rows = await tx.$queryRaw<{ code: string | null; reused: boolean }[]>`
          SELECT * FROM forensic_watermark_issue(
            ${candidate}::text,
            ${sessionKey}::text,
            ${target.surface}::forensic_watermark_surface,
            ${viewer.userId}::text,
            ${target.organizationId ?? null}::text,
            ${target.academyId}::text,
            ${target.courseId ?? null}::text,
            ${target.lessonId ?? null}::text,
            ${target.liveSessionId ?? null}::text,
            ${viewer.sessionId}::text,
            ${viewer.deviceId ?? null}::text,
            ${deviceCookieHash}::text,
            ${identity?.sessionStartedAt ?? null}::timestamp(3),
            ${viewer.clientIp ?? null}::text,
            ${viewer.country ?? null}::text,
            ${viewer.userAgent ?? null}::text,
            ${deviceLabel}::text,
            ${snapshot}::text
          )`;
        const code = rows[0]?.code;
        if (!code) continue; // collision: draw again
        return {
          code,
          reused: rows[0].reused,
          display: viewer.userId
            ? {
                code: formatWatermarkCode(code),
                kind: 'account',
                maskedIdentity: maskEmail(identity?.snapshot.email),
                host: null,
              }
            : {
                code: formatWatermarkCode(code),
                kind: 'preview',
                maskedIdentity: null,
                host: viewer.requestHost ?? null,
              },
        };
      }
      throw new WatermarkIssuanceError('Could not draw a unique watermark code.');
    } catch (error) {
      if (error instanceof WatermarkIssuanceError) throw error;
      // Identifiers only — never the viewer's identity.
      this.logger.error(
        {
          surface: target.surface,
          academyId: target.academyId,
          lessonId: target.lessonId ?? null,
          liveSessionId: target.liveSessionId ?? null,
          error: error instanceof Error ? error.message : String(error),
        },
        'Forensic watermark issuance failed; the video credential is withheld.',
      );
      throw new WatermarkIssuanceError('Forensic watermark issuance failed.', error);
    }
  }

  /** As above, in a transaction of its own (the live-class redeem). */
  async issue(
    viewer: WatermarkViewer,
    target: WatermarkTarget,
  ): Promise<IssuedWatermark> {
    const work = (tx: Prisma.TransactionClient) =>
      this.issueInTransaction(tx, viewer, target);
    try {
      return viewer.userId
        ? await this.tenancyContextService.runInUserContext(viewer.userId, work)
        : await this.tenancyContextService.runWithoutContext(work);
    } catch (error) {
      if (error instanceof WatermarkIssuanceError) throw error;
      throw new WatermarkIssuanceError('Forensic watermark issuance failed.', error);
    }
  }

  /**
   * "Still on screen" from the playback heartbeat. Gated in Redis so the
   * database sees at most one write a minute per viewer and lesson, and
   * best-effort: a heartbeat is never failed because of this.
   */
  async touchFromHeartbeat(args: {
    readonly userId: string;
    readonly sessionId: string | null;
    readonly lessonId: string;
  }): Promise<void> {
    if (!args.sessionId) return;
    try {
      const gate = await this.redisService
        .getClient()
        .set(
          `wm:touch:${args.sessionId}:${args.lessonId}`,
          '1',
          'EX',
          TOUCH_INTERVAL_SECONDS,
          'NX',
        );
      if (gate !== 'OK') return;
    } catch {
      // Redis down: the database function's own one-minute guard still holds.
    }
    try {
      await this.tenancyContextService.runInUserContext(
        args.userId,
        (tx) =>
          tx.$queryRaw`SELECT forensic_watermark_touch(${args.sessionId}::text, ${args.lessonId}::text)`,
      );
    } catch (error) {
      this.logger.warn(
        {
          lessonId: args.lessonId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Could not refresh a forensic watermark last-seen time.',
      );
    }
  }

  /**
   * One tamper report from the player's watchdog. Counted only on the
   * caller's own record (the database function decides), throttled there to
   * once per 30 s. Returns whether anything was counted.
   */
  async recordTamper(args: {
    readonly userId: string | null;
    readonly code: string;
    readonly deviceCookie: string | null;
  }): Promise<boolean> {
    const cookieHash = args.deviceCookie ? hashDeviceCookie(args.deviceCookie) : null;
    const work = (tx: Prisma.TransactionClient) =>
      tx.$queryRaw<{ counted: number }[]>`
        SELECT forensic_watermark_record_tamper(${args.code}::text, ${cookieHash}::text) AS counted`;
    const rows = args.userId
      ? await this.tenancyContextService.runInUserContext(args.userId, work)
      : await this.tenancyContextService.runWithoutContext(work);
    return (rows[0]?.counted ?? 0) > 0;
  }

  /**
   * Retention: deletes records last shown before `cutoff`. Must run in a
   * Platform Owner's context (row visibility); the delete policy independently
   * refuses anything shown in the last 90 days.
   */
  async pruneOlderThan(tx: Prisma.TransactionClient, cutoff: Date): Promise<number> {
    const result = await tx.forensicWatermark.deleteMany({
      where: { lastSeenAt: { lt: cutoff } },
    });
    return result.count;
  }

  /**
   * One code per (surface, viewer, session, target). A signed-in viewer is
   * keyed by account + session, so a new sign-in is a new code; an anonymous
   * visitor by their device cookie, or — with no cookie — by network + agent
   * + UTC day, so a preview's credential refreshes do not mint a new code
   * every few minutes.
   */
  sessionKey(viewer: WatermarkViewer, target: WatermarkTarget): string {
    const who = viewer.userId
      ? `user:${viewer.userId}:${viewer.sessionId ?? 'no-session'}`
      : viewer.deviceCookie
        ? `anon-device:${hashDeviceCookie(viewer.deviceCookie)}`
        : `anon-network:${viewer.clientIp ?? '-'}:${viewer.userAgent ?? '-'}:${new Date()
            .toISOString()
            .slice(0, 10)}`;
    const what =
      target.surface === 'live_session'
        ? `live:${target.liveSessionId}`
        : `lesson:${target.courseId}:${target.lessonId}`;
    return createHash('sha256')
      .update(`atlas.watermark.v1|${target.surface}|${who}|${what}`)
      .digest('hex');
  }

  /**
   * The viewer's identity and session facts, read in their OWN context —
   * the only context in which `user_phones` and `refresh_tokens` admit them.
   */
  private async readIdentity(
    tx: Prisma.TransactionClient,
    viewer: WatermarkViewer,
  ): Promise<{
    readonly snapshot: Omit<WatermarkIdentitySnapshot, 'target'>;
    readonly sessionStartedAt: Date | null;
  }> {
    const userId = viewer.userId as string;
    const [user, phone, session] = await Promise.all([
      tx.user.findUnique({ where: { id: userId }, select: { name: true, email: true } }),
      tx.userPhone.findUnique({
        where: { userId },
        select: { phoneE164: true, countryCode: true },
      }),
      viewer.sessionId
        ? tx.refreshToken.findFirst({
            where: { userId, sessionId: viewer.sessionId },
            orderBy: { createdAt: 'asc' },
            select: {
              sessionStartedAt: true,
              createdAt: true,
              ipAddress: true,
              locationCountry: true,
              deviceLabel: true,
              userAgent: true,
            },
          })
        : Promise.resolve(null),
    ]);
    if (!user) {
      // The context could not see its own account: refuse rather than issue
      // a code that identifies nobody.
      throw new WatermarkIssuanceError(
        'The viewer account is not readable in its own context.',
      );
    }
    return {
      snapshot: {
        name: user.name,
        email: user.email,
        phoneE164: phone?.phoneE164 ?? null,
        phoneCountry: phone?.countryCode ?? null,
        sessionSignIn: session
          ? {
              ipAddress: session.ipAddress,
              country: session.locationCountry,
              deviceLabel: session.deviceLabel,
              userAgent: session.userAgent,
            }
          : null,
      },
      sessionStartedAt: session ? (session.sessionStartedAt ?? session.createdAt) : null,
    };
  }
}
