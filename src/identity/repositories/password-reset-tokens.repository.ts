/**
 * PasswordResetTokensRepository.
 */
import { Injectable } from '@nestjs/common';
import type { PasswordResetToken } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export interface CreatePasswordResetTokenInput {
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

@Injectable()
export class PasswordResetTokensRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreatePasswordResetTokenInput): Promise<PasswordResetToken> {
    return this.prisma.passwordResetToken.create({
      data: {
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      },
    });
  }

  /** Only a not-yet-used, not-yet-expired token is ever "valid" — matches master plan §8: "reject invalid/expired/used tokens." */
  findValidByHash(tokenHash: string): Promise<PasswordResetToken | null> {
    return this.prisma.passwordResetToken.findFirst({
      where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
    });
  }

  /**
   * Consumes a valid token in ONE conditional write, so two concurrent
   * confirmations of the same link cannot both proceed (the loser matches
   * zero rows). Returns the consumed row, or null when the token is
   * unknown, expired or already used.
   */
  async claimValidByHash(tokenHash: string): Promise<PasswordResetToken | null> {
    const now = new Date();
    const claimed = await this.prisma.passwordResetToken.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) return null;
    return this.prisma.passwordResetToken.findFirst({ where: { tokenHash } });
  }

  /**
   * Spends every outstanding reset/setup link of an account. After its
   * password has been reset or changed, an older link (a forwarded email,
   * a second reset request) must not be able to set it again.
   */
  async spendAllForUser(userId: string): Promise<number> {
    const result = await this.prisma.passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    });
    return result.count;
  }

  markUsed(id: string): Promise<PasswordResetToken> {
    return this.prisma.passwordResetToken.update({
      where: { id },
      data: { usedAt: new Date() },
    });
  }
}
