/**
 * PasswordResetTokensRepository.
 *
 * Authentication audit, Decision 2 — `password_reset_tokens` is strictly
 * per-user under RLS. A confirmation presents only the token, so its owner
 * is found through `IdentityResolver` by the token's hash, and every
 * statement then runs in that owner's context.
 */
import { Injectable } from '@nestjs/common';
import type { PasswordResetToken, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { runInUserContext } from '../../database/user-context';
import { IdentityResolver } from './identity-resolver';

export interface CreatePasswordResetTokenInput {
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

@Injectable()
export class PasswordResetTokensRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identityResolver: IdentityResolver,
  ) {}

  private asUser<T>(
    userId: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return runInUserContext(this.prisma, userId, work);
  }

  create(input: CreatePasswordResetTokenInput): Promise<PasswordResetToken> {
    return this.asUser(input.userId, (tx) =>
      tx.passwordResetToken.create({
        data: {
          userId: input.userId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
        },
      }),
    );
  }

  /** Only a not-yet-used, not-yet-expired token is ever "valid" — matches master plan §8: "reject invalid/expired/used tokens." */
  async findValidByHash(tokenHash: string): Promise<PasswordResetToken | null> {
    const ownerId = await this.identityResolver.passwordResetTokenOwner(tokenHash);
    if (!ownerId) return null;
    return this.asUser(ownerId, (tx) =>
      tx.passwordResetToken.findFirst({
        where: {
          tokenHash,
          userId: ownerId,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
      }),
    );
  }

  /**
   * Consumes a valid token in ONE conditional write, so two concurrent
   * confirmations of the same link cannot both proceed (the loser matches
   * zero rows). Returns the consumed row, or null when the token is
   * unknown, expired or already used.
   */
  async claimValidByHash(tokenHash: string): Promise<PasswordResetToken | null> {
    const ownerId = await this.identityResolver.passwordResetTokenOwner(tokenHash);
    if (!ownerId) return null;
    const now = new Date();
    return this.asUser(ownerId, async (tx) => {
      const claimed = await tx.passwordResetToken.updateMany({
        where: { tokenHash, userId: ownerId, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) return null;
      return tx.passwordResetToken.findFirst({ where: { tokenHash } });
    });
  }

  /**
   * Spends every outstanding reset/setup link of an account. After its
   * password has been reset or changed, an older link (a forwarded email,
   * a second reset request) must not be able to set it again.
   */
  async spendAllForUser(userId: string): Promise<number> {
    const result = await this.asUser(userId, (tx) =>
      tx.passwordResetToken.updateMany({
        where: { userId, usedAt: null },
        data: { usedAt: new Date() },
      }),
    );
    return result.count;
  }
}
