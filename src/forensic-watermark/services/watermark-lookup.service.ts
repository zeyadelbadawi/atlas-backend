/**
 * WatermarkLookupService — the Platform Owner's "who leaked this?" answer
 * (`GET /platform/watermarks/:code`, docs/FORENSIC_WATERMARK.md).
 *
 * AUTHORIZATION, THREE TIMES. The controller's guard stack (JWT, management
 * surface, Platform Owner), a per-owner rate limit, and RLS underneath:
 * `forensic_watermarks` admits a row only to `is_platform_owner(...)`, so this
 * service reading in the operator's own user context sees nothing at all if
 * the guard were ever bypassed.
 *
 * EVERY LOOKUP IS AUDITED — found or not — in the same transaction as the
 * read, as `platform.watermark.looked_up`. The audit context carries whether
 * it matched and the surface, never the identity it revealed: the audit log
 * is not a second copy of the snapshot.
 *
 * THE SNAPSHOT IS DECRYPTED HERE AND NOWHERE ELSE, returned on the response
 * and never logged.
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { ForensicWatermark, Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import {
  formatWatermarkCode,
  normalizeWatermarkCode,
} from '../utils/watermark-code.util';
import { parseUserAgent } from '../utils/viewer-display.util';
import {
  WatermarkSnapshotCipher,
  type WatermarkIdentitySnapshot,
} from './watermark-snapshot-cipher.service';
import { WatermarkLookupRateLimiter } from './watermark-lookup.rate-limiter';
import type {
  WatermarkAccountState,
  WatermarkLookupResponse,
} from '../dto/forensic-watermark.contract';

export const WATERMARK_LOOKUP_AUDIT_ACTION = 'platform.watermark.looked_up';
/** Related codes listed per lookup — a session rarely has more; the list is a lead, not a report. */
const RELATED_LIMIT = 50;

@Injectable()
export class WatermarkLookupService {
  private readonly logger = new Logger(WatermarkLookupService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly cipher: WatermarkSnapshotCipher,
    private readonly rateLimiter: WatermarkLookupRateLimiter,
  ) {}

  async lookup(
    platformOwnerId: string,
    rawCode: string,
  ): Promise<WatermarkLookupResponse> {
    await this.rateLimiter.consume(platformOwnerId);

    const normalized = normalizeWatermarkCode(rawCode);
    if (!normalized.ok) {
      // Not audited: nothing was read. A malformed or misread code is told
      // apart from "not found" so the operator re-reads the recording.
      throw new BadRequestException({
        messageKey:
          normalized.problem === 'checksum'
            ? 'errors.watermark.checksumMismatch'
            : 'errors.watermark.invalidCode',
        details: { problem: normalized.problem },
      });
    }

    const result = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      async (tx) => {
        const row = await tx.forensicWatermark.findUnique({
          where: { code: normalized.code },
        });

        await this.auditLogWriterService.write(tx, {
          actorUserId: platformOwnerId,
          role: 'platform_owner',
          action: WATERMARK_LOOKUP_AUDIT_ACTION,
          targetType: 'forensic_watermark',
          targetId: row?.id ?? 'not_found',
          targetLabel: normalized.display,
          context: {
            found: Boolean(row),
            surface: row?.surface,
            accountLinked: row ? Boolean(row.userId) : undefined,
          },
        });

        if (!row) return null;
        return this.buildResponse(tx, row);
      },
    );

    if (!result) throw new NotFoundException({ messageKey: 'errors.watermark.notFound' });
    return result;
  }

  private async buildResponse(
    tx: Prisma.TransactionClient,
    row: ForensicWatermark,
  ): Promise<WatermarkLookupResponse> {
    const academy = await tx.academy.findUnique({
      where: { id: row.academyId },
      select: { name: true, organizationId: true },
    });
    // The learner's own context often cannot read `academies` at issue time,
    // so the organization is resolved here when the row does not carry it.
    const organizationId = row.organizationId ?? academy?.organizationId ?? null;
    const [user, organization, course, lesson, liveSession, related] = await Promise.all([
      row.userId
        ? tx.user.findUnique({
            where: { id: row.userId },
            select: { name: true, email: true, status: true, deletedAt: true },
          })
        : Promise.resolve(null),
      organizationId
        ? tx.organization.findUnique({
            where: { id: organizationId },
            select: { name: true },
          })
        : Promise.resolve(null),
      row.courseId
        ? tx.course.findUnique({ where: { id: row.courseId }, select: { title: true } })
        : Promise.resolve(null),
      row.lessonId
        ? tx.courseLesson.findUnique({
            where: { id: row.lessonId },
            select: { title: true },
          })
        : Promise.resolve(null),
      row.liveSessionId
        ? tx.liveSession.findUnique({
            where: { id: row.liveSessionId },
            select: { title: true, scheduledStartAt: true },
          })
        : Promise.resolve(null),
      this.relatedRows(tx, row),
    ]);
    const organizationName = organization?.name ?? null;

    let snapshot: WatermarkIdentitySnapshot | null = null;
    let snapshotStatus: WatermarkLookupResponse['snapshotStatus'] = 'absent';
    if (row.identitySnapshot) {
      try {
        snapshot = this.cipher.decrypt(row.identitySnapshot, row.code);
        snapshotStatus = 'ok';
      } catch {
        snapshotStatus = 'unreadable';
        this.logger.warn(
          { watermarkId: row.id },
          'A forensic watermark identity snapshot could not be decrypted (tampered row or rotated key).',
        );
      }
    }

    const state: WatermarkAccountState = !row.userId
      ? 'anonymous'
      : !user
        ? 'missing'
        : user.status === 'deleted' || user.deletedAt
          ? 'deleted'
          : user.status === 'suspended'
            ? 'suspended'
            : 'active';
    const live = state === 'active' || state === 'suspended';
    const parsed = parseUserAgent(row.userAgent);
    const titles = await this.relatedTitles(tx, related);

    return {
      code: formatWatermarkCode(row.code),
      surface: row.surface,
      issuedAt: row.issuedAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      tamperEvents: row.tamperEventCount,
      lastTamperAt: row.lastTamperAt?.toISOString() ?? null,
      account: {
        userId: row.userId,
        state,
        currentName: live ? (user?.name ?? null) : null,
        currentEmail: live ? (user?.email ?? null) : null,
        deletedAt: user?.deletedAt?.toISOString() ?? null,
      },
      identityAtIssue: snapshot
        ? {
            name: snapshot.name,
            email: snapshot.email,
            phone: snapshot.phoneE164,
            phoneCountry: snapshot.phoneCountry,
          }
        : null,
      snapshotStatus,
      content: {
        organization: {
          id: organizationId,
          name: organizationName ?? snapshot?.target.organizationName ?? null,
        },
        academy: {
          id: row.academyId,
          name: academy?.name ?? snapshot?.target.academyName ?? null,
        },
        course: row.courseId
          ? {
              id: row.courseId,
              title: course?.title ?? snapshot?.target.courseTitle ?? null,
            }
          : null,
        lesson: row.lessonId
          ? {
              id: row.lessonId,
              title: lesson?.title ?? snapshot?.target.lessonTitle ?? null,
            }
          : null,
        liveSession: row.liveSessionId
          ? {
              id: row.liveSessionId,
              title: liveSession?.title ?? snapshot?.target.liveSessionTitle ?? null,
              scheduledStartAt: liveSession?.scheduledStartAt?.toISOString() ?? null,
            }
          : null,
      },
      session: {
        id: row.sessionId,
        startedAt: row.sessionStartedAt?.toISOString() ?? null,
        signInIp: snapshot?.sessionSignIn?.ipAddress ?? null,
        signInCountry: snapshot?.sessionSignIn?.country ?? null,
        signInDevice: snapshot?.sessionSignIn?.deviceLabel ?? null,
      },
      device: {
        id: row.deviceId,
        label: row.deviceLabel,
        userAgent: row.userAgent,
        browser: parsed.browser,
        os: parsed.os,
        type: parsed.type,
      },
      network: { ip: row.clientIp, country: row.country },
      relatedInSession: related.map((other) => ({
        code: formatWatermarkCode(other.code),
        surface: other.surface,
        courseTitle: other.courseId ? (titles.courses.get(other.courseId) ?? null) : null,
        lessonTitle: other.lessonId ? (titles.lessons.get(other.lessonId) ?? null) : null,
        liveSessionTitle: other.liveSessionId
          ? (titles.liveSessions.get(other.liveSessionId) ?? null)
          : null,
        issuedAt: other.issuedAt.toISOString(),
        lastSeenAt: other.lastSeenAt.toISOString(),
        tamperEvents: other.tamperEventCount,
      })),
    };
  }

  /** The same session's other codes — or, for an anonymous preview, the same device's. */
  private relatedRows(tx: Prisma.TransactionClient, row: ForensicWatermark) {
    const sameViewer: Prisma.ForensicWatermarkWhereInput | null = row.sessionId
      ? { sessionId: row.sessionId, userId: row.userId }
      : row.deviceCookieHash
        ? { deviceCookieHash: row.deviceCookieHash, userId: null }
        : null;
    if (!sameViewer) return Promise.resolve([]);
    return tx.forensicWatermark.findMany({
      where: { ...sameViewer, id: { not: row.id } },
      orderBy: { issuedAt: 'asc' },
      take: RELATED_LIMIT,
      select: {
        code: true,
        surface: true,
        courseId: true,
        lessonId: true,
        liveSessionId: true,
        issuedAt: true,
        lastSeenAt: true,
        tamperEventCount: true,
      },
    });
  }

  private async relatedTitles(
    tx: Prisma.TransactionClient,
    related: readonly {
      courseId: string | null;
      lessonId: string | null;
      liveSessionId: string | null;
    }[],
  ) {
    const ids = (key: 'courseId' | 'lessonId' | 'liveSessionId') => [
      ...new Set(related.map((r) => r[key]).filter((id): id is string => Boolean(id))),
    ];
    const [courses, lessons, liveSessions] = await Promise.all([
      tx.course.findMany({
        where: { id: { in: ids('courseId') } },
        select: { id: true, title: true },
      }),
      tx.courseLesson.findMany({
        where: { id: { in: ids('lessonId') } },
        select: { id: true, title: true },
      }),
      tx.liveSession.findMany({
        where: { id: { in: ids('liveSessionId') } },
        select: { id: true, title: true },
      }),
    ]);
    return {
      courses: new Map(courses.map((c) => [c.id, c.title])),
      lessons: new Map(lessons.map((l) => [l.id, l.title])),
      liveSessions: new Map(liveSessions.map((s) => [s.id, s.title])),
    };
  }
}
