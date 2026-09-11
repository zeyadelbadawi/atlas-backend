/**
 * RefreshTokensRepository.
 *
 * `rotate()` is the concurrency-critical method — see its doc comment.
 */
import { Injectable } from '@nestjs/common';
import type { RefreshToken } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export interface CreateRefreshTokenInput {
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly deviceLabel?: string;
  /** Phase 10 — the stable device-session id. Minted at sign-in, copied forward by every rotation. See `schema.prisma`'s own doc comment. */
  readonly sessionId: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  readonly locationCountry?: string;
}

/** One device session: the rotation family's newest row, plus when the family began. */
export interface SessionSummaryRow {
  readonly sessionId: string;
  readonly deviceLabel: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly locationCountry: string | null;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  /** `createdAt` of the FIRST row in the family — when the user actually signed in on this device, not when the token last rotated. */
  readonly startedAt: Date;
}

@Injectable()
export class RefreshTokensRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateRefreshTokenInput): Promise<RefreshToken> {
    return this.prisma.refreshToken.create({
      data: {
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        deviceLabel: input.deviceLabel,
        sessionId: input.sessionId,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        locationCountry: input.locationCountry,
        // A brand-new session's last activity is its creation — a real
        // timestamp for a real event, not a placeholder.
        lastUsedAt: new Date(),
      },
    });
  }

  findById(id: string): Promise<RefreshToken | null> {
    return this.prisma.refreshToken.findUnique({ where: { id } });
  }

  findValidByHash(tokenHash: string): Promise<RefreshToken | null> {
    return this.prisma.refreshToken.findFirst({
      where: { tokenHash, revokedAt: null, expiresAt: { gt: new Date() } },
    });
  }

  /**
   * Revokes exactly one refresh token by id, only if it belongs to `userId`
   * and isn't already revoked. Idempotent by design: revoking an
   * already-revoked (or foreign) token is a safe no-op, never an error —
   * `POST /auth/sign-out` must always succeed from the caller's point of
   * view even if the session was already gone.
   */
  async revokeByIdForUser(id: string, userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { id, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Phase 10 — every ACTIVE device session for one user, newest activity
   * first.
   *
   * A session is a rotation family, so this collapses each family to its
   * live row (exactly one per family is unrevoked and unexpired) and
   * reports `startedAt` from the family's earliest row, which is when the
   * user actually signed in on that device rather than when the token
   * last rotated.
   *
   * Scoped by `userId` in the query itself; the service never passes a
   * user id it did not take from the verified access token.
   */
  /**
   * Flushes a session's activity timestamp to Postgres.
   *
   * Called only when `SessionActivityService`'s per-session lease says an
   * interval has elapsed — never on every request. Scoped to the live row
   * of the rotation family; `updateMany` rather than `update` because a
   * session whose row was revoked between the lease and this write should
   * quietly match nothing rather than throw.
   */
  async touchSessionActivity(sessionId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { sessionId, revokedAt: null },
      data: { lastUsedAt: new Date() },
    });
  }

  async findActiveSessionsForUser(userId: string): Promise<SessionSummaryRow[]> {
    const now = new Date();
    const live = await this.prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { lastUsedAt: 'desc' },
    });
    if (live.length === 0) return [];

    // One extra query for the whole page rather than one per session.
    const starts = await this.prisma.refreshToken.groupBy({
      by: ['sessionId'],
      where: { userId, sessionId: { in: live.map((row) => row.sessionId) } },
      _min: { createdAt: true },
    });
    const startedBySession = new Map(
      starts.map((row) => [row.sessionId, row._min.createdAt]),
    );

    return live.map((row) => ({
      sessionId: row.sessionId,
      deviceLabel: row.deviceLabel,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      locationCountry: row.locationCountry,
      lastUsedAt: row.lastUsedAt,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      startedAt: startedBySession.get(row.sessionId) ?? row.createdAt,
    }));
  }

  /**
   * Phase 10 — revokes an entire device session: every row in the
   * rotation family, not just the newest one.
   *
   * Revoking only the live row would be insufficient in the narrow race
   * where a refresh is in flight — the concurrent rotation could commit a
   * fresh row for the family a moment later. Revoking the family closes
   * that window: `rotate` only ever matches an UNREVOKED row, so no
   * member can be exchanged for a new one afterwards.
   *
   * Returns the number of rows revoked so the service can distinguish
   * "revoked something" from "this session id does not belong to you /
   * does not exist" without a second query. Scoped by `userId`, so a
   * caller supplying another user's session id revokes nothing.
   */
  async revokeSessionForUser(sessionId: string, userId: string): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  /** Phase 10 — how many rows in this rotation family are still usable. `0` means the session is dead. Used as `SessionRevocationService`'s authoritative fallback when Redis is unavailable. */
  countLiveRowsForSession(sessionId: string): Promise<number> {
    return this.prisma.refreshToken.count({
      where: { sessionId, revokedAt: null, expiresAt: { gt: new Date() } },
    });
  }

  /** Revokes every active refresh token for a user — password reset / change-password only (master plan §8/§21 P1). Never used by plain sign-out. */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Atomic refresh-token rotation.
   *
   * Two concurrent callers presenting the *same* refresh token must not
   * both succeed (master plan §21 P1: "Concurrent refresh requests using
   * the same refresh token must be handled safely... use a transaction and
   * an atomic compare-and-revoke/update strategy").
   *
   * The `updateMany({ where: { tokenHash, revokedAt: null, expiresAt: {
   * gt: now } } })` below is the compare-and-swap: Postgres executes it
   * under a row lock, so under concurrent transactions the second caller's
   * `UPDATE` blocks until the first commits, then re-evaluates
   * `revokedAt: null` against the now-committed row and matches zero rows.
   * Only the caller whose `updateMany` reports `count === 1` "wins" the
   * claim; every other concurrent caller (and any later replay of the same
   * token) gets `null` back and must be treated as an invalid-refresh-token
   * failure by the service layer. The claim and the new row's creation run
   * inside one interactive transaction so a failure after the claim can
   * never leave a token revoked with no replacement issued.
   */
  async rotate(
    presentedTokenHash: string,
    newToken: Omit<CreateRefreshTokenInput, 'userId' | 'sessionId'>,
  ): Promise<{ claimed: RefreshToken; created: RefreshToken } | null> {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const claim = await tx.refreshToken.updateMany({
        where: { tokenHash: presentedTokenHash, revokedAt: null, expiresAt: { gt: now } },
        data: { revokedAt: now },
      });

      if (claim.count !== 1) {
        return null;
      }

      const claimed = await tx.refreshToken.findUniqueOrThrow({
        where: { tokenHash: presentedTokenHash },
      });
      // The new token belongs to whoever owned the token just claimed —
      // never supplied by the caller, so there is no way to rotate a
      // presented token into a session for a different user.
      const created = await tx.refreshToken.create({
        data: {
          userId: claimed.userId,
          tokenHash: newToken.tokenHash,
          expiresAt: newToken.expiresAt,
          // Phase 10 — the rotated row stays the SAME device session. The
          // family id is inherited from the claimed row, never taken from
          // the caller, so a refresh can neither start a new session nor
          // graft this token onto someone else's.
          sessionId: claimed.sessionId,
          // Device label and user agent are re-read from the live request
          // (a browser upgrade should update them), but fall back to the
          // claimed row so a refresh from a client that sends no
          // User-Agent never blanks out what we already knew.
          deviceLabel: newToken.deviceLabel ?? claimed.deviceLabel,
          userAgent: newToken.userAgent ?? claimed.userAgent,
          ipAddress: newToken.ipAddress ?? claimed.ipAddress,
          // Carried forward when the new request did not resolve one, so
          // a refresh from a context without Cloudflare (a health probe,
          // a test) never erases a country already known for the session.
          locationCountry: newToken.locationCountry ?? claimed.locationCountry,
          // Real activity: this refresh actually happened, now.
          lastUsedAt: now,
        },
      });

      return { claimed, created };
    });
  }
}
