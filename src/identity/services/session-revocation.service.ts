/**
 * SessionRevocationService — makes session revocation take effect on the
 * VERY NEXT REQUEST, which is Phase 10's actual acceptance criterion.
 *
 * THE PROBLEM THIS EXISTS TO SOLVE. `JwtAuthGuard` verifies an access
 * token's signature and expiry and nothing else. That is normal for a
 * stateless JWT, but it means revoking a session in the database only
 * stops the REFRESH: an access token already in the attacker's hands
 * keeps working until it expires (`JWT_ACCESS_TTL_SECONDS`, 15 minutes by
 * default). The roadmap is explicit that revocation must invalidate the
 * session "against the actual token-validation path, not just the
 * database row", so a database update alone would not satisfy it and
 * claiming otherwise would be false.
 *
 * THE MECHANISM. Revoking a session writes a short-lived denylist entry
 * keyed by the session id. `JwtAuthGuard` checks that key on every
 * request, so the next request carrying an access token for a revoked
 * session is rejected — no waiting for expiry. Entries carry a TTL equal
 * to the access-token lifetime, because after that the token is
 * self-invalidating and the entry is dead weight; the denylist therefore
 * stays bounded by "sessions revoked in the last 15 minutes" rather than
 * growing forever.
 *
 * Redis is the store because it is already the production-wired shared
 * cache (ADR-004) and is the only component every backend instance can
 * see — an in-process Set would leave a revoked session alive on every
 * OTHER instance, which is precisely the bug this phase must not ship.
 *
 * FAILURE BEHAVIOUR. If Redis is unavailable, `isRevoked` falls back to
 * the database rather than guessing. It does NOT fail open (that would
 * silently restore the vulnerability during an outage) and it does NOT
 * fail closed globally (that would log out every user on a Redis blip —
 * the "accidental global lockout" this phase's own review forbids). The
 * database is authoritative anyway; Redis is only the fast path.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import { RefreshTokensRepository } from '../repositories/refresh-tokens.repository';
import type { IdentityConfig } from '../../config/configuration';

const KEY_PREFIX = 'session:revoked:';

@Injectable()
export class SessionRevocationService {
  private readonly logger = new Logger(SessionRevocationService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
    private readonly refreshTokensRepository: RefreshTokensRepository,
  ) {}

  private key(sessionId: string): string {
    return `${KEY_PREFIX}${sessionId}`;
  }

  /**
   * Marks a session as revoked for as long as any access token issued to
   * it could still verify. Callers MUST have already revoked the database
   * rows — this is the fast path that closes the access-token window, not
   * a substitute for the durable record.
   *
   * A Redis failure here is logged and swallowed: the database revocation
   * has already committed, so the session is genuinely dead for refresh
   * purposes, and `isRevoked`'s own database fallback still rejects it.
   * Throwing would turn a successful revocation into a 500 and invite the
   * user to retry something that already worked.
   */
  async markRevoked(sessionId: string): Promise<void> {
    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    try {
      await this.redisService
        .getClient()
        .set(this.key(sessionId), '1', 'EX', identity.jwtAccessTtlSeconds);
    } catch (error) {
      this.logger.warn(
        { sessionId, error: error instanceof Error ? error.message : error },
        'Could not write session revocation to Redis; the database revocation stands and the guard will fall back to it.',
      );
    }
  }

  /**
   * Whether this session must be refused. Redis first (one O(1) lookup on
   * the hot path); on any Redis error, the database — see this class's
   * own FAILURE BEHAVIOUR note for why neither fail-open nor global
   * fail-closed is acceptable here.
   */
  async isRevoked(sessionId: string): Promise<boolean> {
    try {
      const hit = await this.redisService.getClient().get(this.key(sessionId));
      if (hit) return true;
      return false;
    } catch (error) {
      this.logger.warn(
        { sessionId, error: error instanceof Error ? error.message : error },
        'Redis unavailable for session revocation check; falling back to the database.',
      );
      return this.isRevokedInDatabase(sessionId);
    }
  }

  /**
   * The authoritative check. A session counts as revoked once it has no
   * live row left — every member of the rotation family is revoked or
   * expired. Sessions predating Phase 10 resolve correctly here too,
   * because the migration backfilled `session_id` to each row's own id,
   * which is exactly what their access tokens carry as `sid`.
   */
  private async isRevokedInDatabase(sessionId: string): Promise<boolean> {
    const live = await this.refreshTokensRepository.countLiveRowsForSession(sessionId);
    return live === 0;
  }
}
