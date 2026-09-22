/**
 * `content_access_log` writes and the 90-day retention sweep (master plan
 * Phase 2 §F).
 *
 * EVERY DECISION IS RECORDED, NOT JUST THE REFUSALS. Logging only
 * refusals is the intuitive choice and the wrong one: the behaviour this
 * table has to make visible is a legitimate, fully entitled account
 * pulling grants at a rate no human watches at (Phase 2 §U's "p99 > 40
 * per 10 minutes"), and every one of those requests is a GRANT.
 *
 * Writes are best-effort by design — see `record`.
 */
import { Injectable, Logger } from '@nestjs/common';
import type {
  ContentAccessResult,
  MediaAssetProvider,
  Prisma,
  VideoSecurityTier,
} from '@prisma/client';

export interface ContentAccessLogEntry {
  readonly userId: string | null;
  readonly academyId: string;
  readonly courseId: string;
  readonly lessonId: string;
  readonly result: ContentAccessResult;
  readonly reason: string | null;
  readonly deviceId: string | null;
  readonly sessionId: string | null;
  /**
   * P64 Phase 2 (D10) — WHICH tier and provider served this decision.
   *
   * Required because Normal and Premium assets coexist inside one academy
   * (D11), so the forensic question "was this lesson delivered under the
   * protection we sold them?" has to be answerable from the log alone.
   * Null for a refusal that never reached an asset, and for text lessons,
   * which have no provider.
   */
  readonly securityTier?: VideoSecurityTier | null;
  readonly provider?: MediaAssetProvider | null;
}

@Injectable()
export class ContentAccessLogRepository {
  private readonly logger = new Logger(ContentAccessLogRepository.name);

  /**
   * Never throws.
   *
   * An audit write that can fail a request turns the audit trail into an
   * availability dependency of the thing it audits — a learner would be
   * shown a 500 because a log row could not be inserted. The failure is
   * surfaced in the application log instead, where it is visible without
   * being load-bearing.
   */
  async record(
    tx: Prisma.TransactionClient,
    entry: ContentAccessLogEntry,
  ): Promise<void> {
    try {
      // `createMany`, not `create`.
      //
      // Prisma's `create` issues `INSERT … RETURNING`, so it needs a
      // SELECT tier as well as an INSERT one. `logRefusal` deliberately
      // writes with NO context — a learner who was just refused may have
      // no rows visible to them at all, and the record of the refusal has
      // to exist regardless — and no SELECT policy admits an
      // uncontextualised caller, so every refusal insert failed on the
      // RETURNING clause alone (security audit SEC-2).
      //
      // `createMany` emits a plain `INSERT` and returns a count. Nothing
      // here ever needed the row back, so the RETURNING was pure cost and
      // a silent failure mode.
      await tx.contentAccessLog.createMany({
        data: {
          userId: entry.userId,
          academyId: entry.academyId,
          courseId: entry.courseId,
          lessonId: entry.lessonId,
          result: entry.result,
          reason: entry.reason,
          deviceId: entry.deviceId,
          sessionId: entry.sessionId,
          securityTier: entry.securityTier ?? null,
          provider: entry.provider ?? null,
        },
      });
    } catch (error) {
      this.logger.warn(
        {
          academyId: entry.academyId,
          lessonId: entry.lessonId,
          result: entry.result,
          error: error instanceof Error ? error.message : String(error),
        },
        'Could not write a content-access log entry.',
      );
    }
  }

  /**
   * Grants by this learner in the trailing window — the input to the
   * per-student grant-rate report (Phase 2 §U). Counted from the durable
   * log rather than from the rate limiter's own counter, because the
   * limiter is a short-lived Redis key and a report has to survive a
   * restart.
   */
  countRecentGrants(
    tx: Prisma.TransactionClient,
    userId: string,
    since: Date,
  ): Promise<number> {
    return tx.contentAccessLog.count({
      where: { userId, result: 'granted', createdAt: { gte: since } },
    });
  }

  /** Retention (Phase 2 §F). The DELETE policy independently refuses anything inside the window. */
  async pruneOlderThan(tx: Prisma.TransactionClient, cutoff: Date): Promise<number> {
    const result = await tx.contentAccessLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return result.count;
  }
}
