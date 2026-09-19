/**
 * Per-learner rate limit on content grants (master plan Phase 2 §I/§U).
 *
 * WHAT IT IS ACTUALLY FOR. Not brute force — the caller is already
 * authenticated and already entitled. It is for the one pattern that
 * looks completely normal lesson-by-lesson and is obvious in aggregate: a
 * single account walking an entire catalogue, minting a signed URL for
 * every lesson, to collect them. A human watching a course asks for a
 * handful of grants an hour; a scraper asks for hundreds a minute.
 *
 * The ceiling is therefore set well above real use and well below
 * automation. It refuses the request rather than the session: a learner
 * who somehow trips it waits, and nothing about their account changes.
 *
 * FAILS OPEN, ON PURPOSE. When Redis is unreachable this returns `true`.
 * The limiter is a deterrent layered on top of seven entitlement
 * conditions that have all already passed — every request it would have
 * refused is a request from someone genuinely entitled to that content —
 * so a cache outage must not become a content outage. The refusals that
 * matter for security fail CLOSED elsewhere.
 */
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

/** Well above a human's reading pace, well below a crawler's. */
export const GRANT_LIMIT_PER_WINDOW = 120;
export const GRANT_WINDOW_SECONDS = 600;

@Injectable()
export class ContentGrantRateLimiter {
  private readonly logger = new Logger(ContentGrantRateLimiter.name);

  constructor(private readonly redisService: RedisService) {}

  /** Counts one grant. Returns false when the learner is over the ceiling for the current window. */
  async consume(userId: string): Promise<boolean> {
    try {
      const client = this.redisService.getClient();
      const key = `content_grants:${userId}`;
      const count = await client.incr(key);
      if (count === 1) {
        // Only the first increment sets the TTL, so the window is fixed
        // from the first request rather than sliding forward with every
        // one — otherwise a steady stream of requests would keep the key
        // alive indefinitely and the limit would never reset.
        await client.expire(key, GRANT_WINDOW_SECONDS);
      }
      if (count > GRANT_LIMIT_PER_WINDOW) {
        this.logger.warn(
          { userId, count, windowSeconds: GRANT_WINDOW_SECONDS },
          'Content-grant rate limit exceeded for a learner.',
        );
        return false;
      }
      return true;
    } catch (error) {
      this.logger.warn(
        { userId, error: error instanceof Error ? error.message : String(error) },
        'Content-grant rate limiter unavailable; allowing the request.',
      );
      return true;
    }
  }
}
