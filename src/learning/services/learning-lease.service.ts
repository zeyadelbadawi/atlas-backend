/**
 * The learning LEASE — "one learner, one active learning session at a
 * time" (master plan AD-10, D4, Phase 2 §D.7).
 *
 * WHY A LEASE AND NOT A SESSION COUNT
 *
 * Counting live sessions would need a reliable "this browser stopped
 * learning" signal, and there isn't one: tabs are closed, laptops sleep,
 * networks drop, and `beforeunload` is best-effort at best. A learner
 * whose browser crashed would be locked out of their own account until
 * something cleaned up after them.
 *
 * A short-TTL key inverts that. The browser holding the lease renews it
 * every 20 seconds; if it stops for any reason the lease simply expires
 * 60 seconds later and the next device takes it. Nothing has to observe a
 * departure, and the worst case is a minute's wait rather than a support
 * ticket.
 *
 * WHAT THE LEASE IS NOT
 *
 * It is not an authorization check. A learner who holds the lease still
 * has to pass every entitlement condition; a learner who does not hold it
 * is refused CONTENT DELIVERY, not access to their account, their
 * progress, or their dashboard. Getting this wrong in the other direction
 * would mean a Redis outage logging every learner out — so every method
 * here is written to fail in the direction that keeps the learner's own
 * data reachable while still refusing to hand out a second concurrent
 * grant.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { LearningLeaseConfig } from '../../config/configuration';
import { RedisService } from '../../redis/redis.service';

export interface LeaseHolder {
  readonly leaseId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly courseId?: string;
  readonly lessonId?: string;
  readonly acquiredAt: string;
}

export type LeaseOutcome =
  | { readonly status: 'acquired'; readonly lease: LeaseHolder; readonly ttlSeconds: number; readonly heartbeatSeconds: number }
  | { readonly status: 'held_by_other'; readonly holder: LeaseHolder }
  /** Redis is unreachable. The caller decides; `LessonContentService` allows delivery and logs, because a cache outage must not become a content outage. */
  | { readonly status: 'unavailable' };

function leaseKey(userId: string, academyId: string): string {
  return `learning_lease:${userId}:${academyId}`;
}

@Injectable()
export class LearningLeaseService {
  private readonly logger = new Logger(LearningLeaseService.name);
  private readonly config: LearningLeaseConfig;

  constructor(
    private readonly redisService: RedisService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<LearningLeaseConfig>('learningLease');
  }

  get ttlSeconds(): number {
    return this.config.ttlSeconds;
  }

  get heartbeatSeconds(): number {
    return this.config.heartbeatSeconds;
  }

  /**
   * Takes the lease, or reports who already has it.
   *
   * `SET key value NX EX ttl` is one atomic round-trip: two devices racing
   * cannot both win, which a read-then-write would allow. The same device
   * and session re-acquiring simply RENEWS — a learner reloading a page
   * must not be told they are competing with themselves.
   */
  async acquire(args: {
    readonly userId: string;
    readonly academyId: string;
    readonly deviceId: string;
    readonly sessionId: string;
    readonly courseId?: string;
    readonly lessonId?: string;
  }): Promise<LeaseOutcome> {
    const key = leaseKey(args.userId, args.academyId);
    const lease: LeaseHolder = {
      leaseId: randomUUID(),
      deviceId: args.deviceId,
      sessionId: args.sessionId,
      courseId: args.courseId,
      lessonId: args.lessonId,
      acquiredAt: new Date().toISOString(),
    };

    try {
      const client = this.redisService.getClient();
      const taken = await client.set(
        key,
        JSON.stringify(lease),
        'EX',
        this.config.ttlSeconds,
        'NX',
      );
      if (taken === 'OK') {
        return {
          status: 'acquired',
          lease,
          ttlSeconds: this.config.ttlSeconds,
          heartbeatSeconds: this.config.heartbeatSeconds,
        };
      }

      const existing = await this.read(key);
      if (!existing) {
        // The holder expired between the SET and the GET. Retry once —
        // this is the ordinary race, not an error, and failing here would
        // show a learner a takeover dialog for a device that is gone.
        const retaken = await client.set(
          key,
          JSON.stringify(lease),
          'EX',
          this.config.ttlSeconds,
          'NX',
        );
        if (retaken === 'OK') {
          return {
            status: 'acquired',
            lease,
            ttlSeconds: this.config.ttlSeconds,
            heartbeatSeconds: this.config.heartbeatSeconds,
          };
        }
        const now = await this.read(key);
        return now
          ? { status: 'held_by_other', holder: now }
          : { status: 'unavailable' };
      }

      if (existing.deviceId === args.deviceId && existing.sessionId === args.sessionId) {
        const renewed: LeaseHolder = {
          ...existing,
          courseId: args.courseId ?? existing.courseId,
          lessonId: args.lessonId ?? existing.lessonId,
        };
        await client.set(key, JSON.stringify(renewed), 'EX', this.config.ttlSeconds);
        return {
          status: 'acquired',
          lease: renewed,
          ttlSeconds: this.config.ttlSeconds,
          heartbeatSeconds: this.config.heartbeatSeconds,
        };
      }

      return { status: 'held_by_other', holder: existing };
    } catch (error) {
      this.logger.error(
        {
          userId: args.userId,
          academyId: args.academyId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Learning lease store unreachable.',
      );
      return { status: 'unavailable' };
    }
  }

  /**
   * TAKEOVER — the learner's own, explicitly confirmed request to move to
   * this device. Overwrites unconditionally; the caller has already asked
   * the learner to confirm, checked that the requester is the same person,
   * and is responsible for auditing it.
   */
  async takeover(args: {
    readonly userId: string;
    readonly academyId: string;
    readonly deviceId: string;
    readonly sessionId: string;
    readonly courseId?: string;
    readonly lessonId?: string;
  }): Promise<{ readonly previous: LeaseHolder | null; readonly lease: LeaseHolder }> {
    const key = leaseKey(args.userId, args.academyId);
    const previous = await this.read(key).catch(() => null);
    const lease: LeaseHolder = {
      leaseId: randomUUID(),
      deviceId: args.deviceId,
      sessionId: args.sessionId,
      courseId: args.courseId,
      lessonId: args.lessonId,
      acquiredAt: new Date().toISOString(),
    };
    await this.redisService
      .getClient()
      .set(key, JSON.stringify(lease), 'EX', this.config.ttlSeconds);
    return { previous, lease };
  }

  /** Heartbeat. Extends only if THIS lease is still the holder — a stale client must not resurrect a lease it already lost. */
  async renew(args: {
    readonly userId: string;
    readonly academyId: string;
    readonly leaseId: string;
  }): Promise<boolean> {
    try {
      const key = leaseKey(args.userId, args.academyId);
      const existing = await this.read(key);
      if (!existing || existing.leaseId !== args.leaseId) return false;
      await this.redisService
        .getClient()
        .set(key, JSON.stringify(existing), 'EX', this.config.ttlSeconds);
      return true;
    } catch {
      return false;
    }
  }

  /** Releases the lease if this holder still owns it. Best-effort: expiry is the real guarantee. */
  async release(userId: string, academyId: string, leaseId: string): Promise<void> {
    try {
      const key = leaseKey(userId, academyId);
      const existing = await this.read(key);
      if (existing && existing.leaseId === leaseId) {
        await this.redisService.getClient().del(key);
      }
    } catch {
      // Expiry covers this. Never surface a lease-release failure to a learner.
    }
  }

  /**
   * Drops the lease regardless of holder — used when an enrollment is
   * revoked or a device is removed, so the browser currently playing stops
   * at its next refresh instead of finishing the lesson.
   */
  async revokeAll(userId: string, academyId: string): Promise<void> {
    try {
      await this.redisService.getClient().del(leaseKey(userId, academyId));
    } catch (error) {
      this.logger.warn(
        {
          userId,
          academyId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Could not revoke learning lease.',
      );
    }
  }

  async current(userId: string, academyId: string): Promise<LeaseHolder | null> {
    return this.read(leaseKey(userId, academyId)).catch(() => null);
  }

  private async read(key: string): Promise<LeaseHolder | null> {
    const raw = await this.redisService.getClient().get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as LeaseHolder;
    } catch {
      return null;
    }
  }
}
