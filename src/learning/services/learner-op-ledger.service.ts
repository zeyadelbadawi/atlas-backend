/**
 * LearnerOpLedger — replay safety for learner writes that can now arrive
 * late, twice, or out of order (academy offline work, Oct 2026).
 *
 * An academy learner can act while offline: the browser keeps the change
 * in a durable outbox and sends it when the connection returns — possibly
 * minutes or hours later, possibly more than once (a response lost on a
 * flaky connection looks exactly like a request that never arrived), and
 * possibly after a newer change made on another device. Two guarantees are
 * needed, and both are kept WITHOUT a schema change:
 *
 *   1. IDEMPOTENCY (assignment submit). A client operation id
 *      (`idempotencyKey`) maps to the outcome it produced, in Redis, for
 *      `IDEMPOTENCY_TTL_SECONDS` — longer than the outbox will ever retry
 *      (the client gives up after 7 days). A replay returns the original
 *      submission instead of submitting again. Redis is the fast path; the
 *      durable guard is the compare-and-set on `submitted_revision` the
 *      caller performs under the enrollment row lock, so even a lost Redis
 *      record can never turn a replay into a second submission that resets
 *      a grade.
 *
 *   2. ORDERING (lesson complete / undo). Each operation carries the time
 *      the learner pressed the button (`clientOpAt`, the device's clock)
 *      and its own id. The latest applied operation per (learner, lesson)
 *      is remembered; an older one arriving later is reported as not
 *      applied instead of overwriting the newer intent. The same operation
 *      replayed is applied again — both are idempotent state-setters — so a
 *      commit that failed after the record was written is simply redone.
 *
 * FAILURE MODE. Redis unavailable → no record is read or written and every
 * write behaves exactly as it did before this ledger existed (plus the
 * database CAS). The ledger never blocks a learner.
 *
 * SCOPE. Every key embeds the user id (and the assignment / lesson id), so
 * a key presented by one learner can never read or replay another's.
 */
import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

/** Longer than the client outbox's 7-day give-up, with margin. */
export const IDEMPOTENCY_TTL_SECONDS = 10 * 24 * 60 * 60;
/** How long the latest lesson operation is remembered. Same reasoning. */
export const LESSON_OP_TTL_SECONDS = 10 * 24 * 60 * 60;
/**
 * A device clock ahead of the server is clamped to this much in the
 * future, so one wrong clock cannot pin a lesson's state against every
 * later operation from a correct device.
 */
export const MAX_CLIENT_CLOCK_LEAD_MS = 2 * 60 * 1000;

export interface SubmissionReplayRecord {
  readonly submissionId: string;
  readonly revision: number;
  readonly fingerprint: string;
}

export interface LessonOpRecord {
  readonly at: number;
  readonly opId: string;
  readonly action: 'complete' | 'undo';
}

export type LessonOpVerdict =
  /** Apply it (new, newer, or the same operation again). */
  | { readonly apply: true; readonly at: number }
  /** A newer operation for this lesson was already applied. */
  | { readonly apply: false; readonly latest: LessonOpRecord };

@Injectable()
export class LearnerOpLedger {
  private readonly logger = new Logger(LearnerOpLedger.name);

  constructor(private readonly redis: RedisService) {}

  /** A stable fingerprint of what a submission carried, so a reused key with a DIFFERENT payload is refused. */
  static fingerprint(parts: Record<string, string | null | undefined>): string {
    const canonical = JSON.stringify(
      Object.keys(parts)
        .sort()
        .map((key) => [key, parts[key] ?? null]),
    );
    return createHash('sha256').update(canonical).digest('hex');
  }

  private submissionKey(userId: string, assignmentId: string, key: string): string {
    return `learning:idem:assignment-submit:${userId}:${assignmentId}:${key}`;
  }

  private lessonKey(userId: string, lessonId: string): string {
    return `learning:lesson-op:${userId}:${lessonId}`;
  }

  async findSubmission(
    userId: string,
    assignmentId: string,
    key: string,
  ): Promise<SubmissionReplayRecord | null> {
    return this.read<SubmissionReplayRecord>(
      this.submissionKey(userId, assignmentId, key),
    );
  }

  async rememberSubmission(
    userId: string,
    assignmentId: string,
    key: string,
    record: SubmissionReplayRecord,
  ): Promise<void> {
    await this.write(
      this.submissionKey(userId, assignmentId, key),
      record,
      IDEMPOTENCY_TTL_SECONDS,
    );
  }

  /**
   * Decides whether a lesson operation stamped `clientOpAt` may be applied,
   * given the latest one applied for this (learner, lesson). Call under the
   * enrollment row lock, so two operations of one learner are judged one
   * after the other. `latest` is null when nothing is remembered.
   */
  static judgeLessonOp(
    latest: LessonOpRecord | null,
    op: { readonly opId: string; readonly clientOpAt: number },
    now: number = Date.now(),
  ): LessonOpVerdict {
    const at = Math.min(op.clientOpAt, now + MAX_CLIENT_CLOCK_LEAD_MS);
    if (!latest || latest.opId === op.opId || latest.at <= at) {
      return { apply: true, at };
    }
    return { apply: false, latest };
  }

  async latestLessonOp(userId: string, lessonId: string): Promise<LessonOpRecord | null> {
    return this.read<LessonOpRecord>(this.lessonKey(userId, lessonId));
  }

  async recordLessonOp(
    userId: string,
    lessonId: string,
    record: LessonOpRecord,
  ): Promise<void> {
    await this.write(this.lessonKey(userId, lessonId), record, LESSON_OP_TTL_SECONDS);
  }

  private async read<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.getClient().get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Learner op ledger unavailable; falling back to the database guards.',
      );
      return null;
    }
  }

  private async write(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.getClient().set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Learner op ledger write failed; the database guards still apply.',
      );
    }
  }
}
