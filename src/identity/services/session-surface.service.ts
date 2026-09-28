/**
 * SessionSurfaceService — Launch Stabilization A1 (D1).
 *
 * THE DEFECT THIS CLOSES. A session records WHERE it was minted
 * (`refresh_tokens.surface` — `management` or `academy` — plus the
 * academy), but nothing read that after sign-in. The access token carries
 * only `sub`/`sid`, and `ManagementSurfaceGuard` judged the PERSON, not
 * the session — so a token minted on an academy website (a tenant-operated
 * origin, possibly a custom domain whose DNS the tenant controls) worked
 * against every management API the person could reach elsewhere.
 *
 * WHY A LOOKUP AND NOT A NEW TOKEN CLAIM. The surface is already stored and
 * is immutable for the life of a session (`rotate` copies it forward), so
 * resolving it server-side needs no change to the token format, covers
 * tokens already in circulation at deploy, and costs one Redis GET per
 * authenticated request (the database only on a cold cache).
 *
 * FAILURE BEHAVIOUR. Redis failure falls back to the database. A session
 * with no row at all resolves to `null`, which every caller treats as
 * "not a management session" — refusing is the safe direction, and such a
 * session is already dead for refresh purposes.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SessionSurface } from '@prisma/client';
import { RedisService } from '../../redis/redis.service';
import { RefreshTokensRepository } from '../repositories/refresh-tokens.repository';
import type { IdentityConfig } from '../../config/configuration';

const KEY_PREFIX = 'session:surface:';

export interface SessionContext {
  readonly surface: SessionSurface;
  readonly academyId: string | null;
}

@Injectable()
export class SessionSurfaceService {
  private readonly logger = new Logger(SessionSurfaceService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
    private readonly refreshTokensRepository: RefreshTokensRepository,
  ) {}

  private key(sessionId: string): string {
    return `${KEY_PREFIX}${sessionId}`;
  }

  /** The surface and academy this session was minted for, or `null` when no session row exists. */
  async contextOf(sessionId: string, userId: string): Promise<SessionContext | null> {
    try {
      const cached = await this.redisService.getClient().get(this.key(sessionId));
      if (cached) return JSON.parse(cached) as SessionContext;
    } catch (error) {
      this.logger.warn(
        { sessionId, error: error instanceof Error ? error.message : error },
        'Redis unavailable for the session-surface lookup; reading the database.',
      );
    }

    const row = await this.refreshTokensRepository.findSessionContext(userId, sessionId);
    if (!row) return null;
    const context: SessionContext = { surface: row.surface, academyId: row.academyId };

    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    try {
      await this.redisService
        .getClient()
        .set(
          this.key(sessionId),
          JSON.stringify(context),
          'EX',
          identity.refreshTokenTtlDays * 24 * 60 * 60,
        );
    } catch {
      // The value is immutable and the database answered; a cache miss next
      // time costs one indexed read, never a wrong answer.
    }
    return context;
  }
}
