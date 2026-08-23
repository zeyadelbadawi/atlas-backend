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
    newToken: Omit<CreateRefreshTokenInput, 'userId'>,
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
          deviceLabel: newToken.deviceLabel,
        },
      });

      return { claimed, created };
    });
  }
}
