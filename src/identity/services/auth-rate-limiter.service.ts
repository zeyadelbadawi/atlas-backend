/**
 * AuthRateLimiterService — Redis-backed brute-force protection.
 *
 * Master plan §8 "Brute-force protection", §16, §21 P1 requirement #20:
 * fixed-window counters keyed per-scope (IP or normalized email), backed by
 * the same Redis instance P0 already wires (ADR-004 — Redis serves cache,
 * sessions, rate-limit, and the queue broker from one instance at MVP).
 *
 * This is deliberately a fixed-window counter (`INCR` + `EXPIRE` on first
 * hit), not a sliding-window log — bounded, simple, and sufficient for a
 * brute-force deterrent; §18's load-testing pass is where a tuned strategy
 * would be revisited if real traffic ever demands it. Not a permanent
 * lockout mechanism — see the master plan §8/§24: "Account lockout —
 * SPECIFICATION-UNDEFINED... rate limiting alone at first." This class is
 * exactly that "rate limiting alone."
 */
import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

export interface RateLimitCheck {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

@Injectable()
export class AuthRateLimiterService {
  constructor(private readonly redisService: RedisService) {}

  /**
   * Increments the counter for `key` and reports whether it's still within
   * `max` for the current window. Never throws — a Redis hiccup here should
   * not itself be the reason a legitimate sign-in fails; callers that want
   * fail-closed behavior can inspect a thrown error separately.
   */
  async consume(
    key: string,
    max: number,
    windowSeconds: number,
  ): Promise<RateLimitCheck> {
    const client = this.redisService.getClient();
    const redisKey = `ratelimit:${key}`;

    const count = await client.incr(redisKey);
    if (count === 1) {
      await client.expire(redisKey, windowSeconds);
    }

    if (count <= max) {
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const ttl = await client.ttl(redisKey);
    return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : windowSeconds };
  }
}
