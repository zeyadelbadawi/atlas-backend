/**
 * SessionActivityService — makes "Last active" mean something.
 *
 * THE PROBLEM. `refresh_tokens.lastUsedAt` was written at sign-in and on
 * token refresh, and nowhere else. A refresh only happens when the access
 * token expires, so a user actively working in Atlas showed a "Last
 * active" that lagged by up to a full access-token lifetime and then
 * jumped. On the session list that reads as stale — which is exactly the
 * complaint, and it is accurate: the field was not tracking activity, it
 * was tracking token rotation.
 *
 * THE CONSTRAINT. The obvious fix — write the timestamp on every
 * authenticated request — is the wrong one. Atlas serves many requests
 * per page view, and each would become an UPDATE on a hot, indexed table.
 * That is real write amplification, real lock contention on the row, and
 * real WAL volume, for a value nobody reads more than a few times a day.
 *
 * THE DESIGN. Two tiers, so precision costs nothing:
 *
 *   1. EVERY authenticated request writes the timestamp to Redis. One
 *      `SET` with a TTL, no round trip to Postgres, and it is the value
 *      the session list actually displays — so "Last active" is accurate
 *      to the second.
 *   2. Postgres is updated at most once per session per
 *      `PERSIST_INTERVAL_MS`, gated by a Redis `SET NX` lease. This is
 *      the durable floor: if Redis is flushed or restarted, the session
 *      list falls back to a value that is at worst one interval stale,
 *      instead of losing activity entirely.
 *
 * FAILURE IS ALWAYS SILENT AND ALWAYS SAFE. Recording activity is
 * telemetry, not authorization. If Redis is down, every method here
 * degrades to "no fresher value known" and the caller falls back to the
 * database column — a request is never failed because its activity could
 * not be recorded.
 */
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { RefreshTokensRepository } from '../repositories/refresh-tokens.repository';

/** How often a session's activity is flushed to Postgres. */
const PERSIST_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How long a Redis activity value outlives the last request.
 *
 * Longer than the persist interval so the fresh value is still available
 * to the session list well after activity stops, but bounded so idle
 * sessions do not accumulate keys forever.
 */
const ACTIVITY_TTL_SECONDS = 24 * 60 * 60;

const activityKey = (sessionId: string) => `session:activity:${sessionId}`;
const persistLeaseKey = (sessionId: string) => `session:activity:persist:${sessionId}`;

@Injectable()
export class SessionActivityService {
  private readonly logger = new Logger(SessionActivityService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly refreshTokensRepository: RefreshTokensRepository,
  ) {}

  /**
   * The single entry point callers use: record activity, and flush to
   * Postgres if the lease says it is time.
   *
   * The database work lives HERE rather than in `JwtAuthGuard` for two
   * reasons. Architecturally, a guard's job is to authorize a request,
   * not to know which repository stores session telemetry. Practically,
   * Nest resolves a guard's dependencies in the context of EVERY module
   * that uses it, so injecting a repository into the guard would require
   * exporting that repository from `AuthCoreModule` to the whole
   * application — widening a module's public surface to serve an
   * implementation detail. This service is constructed once inside
   * `AuthCoreModule`, where the repository is already a provider.
   *
   * Never throws: activity is telemetry, and a request must not fail
   * because its timestamp could not be written.
   */
  async trackRequest(sessionId: string): Promise<void> {
    try {
      if (await this.recordActivity(sessionId)) {
        await this.refreshTokensRepository.touchSessionActivity(sessionId);
      }
    } catch (error) {
      this.logger.debug(
        { sessionId, error: (error as Error).message },
        'Could not persist session activity; continuing.',
      );
    }
  }

  /**
   * Records that `sessionId` was just used.
   *
   * Returns whether the caller should ALSO persist to Postgres now — true
   * at most once per `PERSIST_INTERVAL_MS` per session. The decision is
   * made here, atomically via `SET NX`, so two concurrent requests for the
   * same session cannot both decide to write.
   */
  async recordActivity(sessionId: string): Promise<boolean> {
    try {
      const client = this.redisService.getClient();
      const now = Date.now();

      await client.set(activityKey(sessionId), String(now), 'EX', ACTIVITY_TTL_SECONDS);

      // `NX` makes this a lease: the first request after the interval
      // elapses wins and returns 'OK'; every other request in the window
      // gets null and skips the database entirely.
      const lease = await client.set(
        persistLeaseKey(sessionId),
        '1',
        'PX',
        PERSIST_INTERVAL_MS,
        'NX',
      );
      return lease === 'OK';
    } catch (error) {
      // Telemetry must never break a request.
      this.logger.debug(
        { sessionId, error: (error as Error).message },
        'Could not record session activity; continuing.',
      );
      return false;
    }
  }

  /**
   * The freshest known activity for each session, from Redis.
   *
   * Sessions with no Redis value are simply absent from the result — the
   * caller keeps whatever the database column says, which may legitimately
   * be older or null. Never invents a timestamp for a session that has
   * none.
   */
  async getRecentActivity(
    sessionIds: readonly string[],
  ): Promise<ReadonlyMap<string, Date>> {
    const activity = new Map<string, Date>();
    if (sessionIds.length === 0) return activity;

    try {
      const client = this.redisService.getClient();
      // One round trip for the whole list rather than one per session.
      const values = await client.mget(...sessionIds.map(activityKey));

      sessionIds.forEach((sessionId, index) => {
        const raw = values[index];
        if (!raw) return;
        const millis = Number(raw);
        if (!Number.isFinite(millis)) return;
        activity.set(sessionId, new Date(millis));
      });
    } catch (error) {
      this.logger.debug(
        { error: (error as Error).message },
        'Could not read session activity; falling back to stored values.',
      );
    }

    return activity;
  }

  /** Clears a revoked session's activity so it cannot resurface in a listing. */
  async forget(sessionId: string): Promise<void> {
    try {
      const client = this.redisService.getClient();
      await client.del(activityKey(sessionId), persistLeaseKey(sessionId));
    } catch {
      // The key expires on its own, and a revoked session is never listed
      // anyway — nothing here is worth failing a revocation for.
    }
  }
}
