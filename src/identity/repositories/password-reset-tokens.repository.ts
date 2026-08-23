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

  markUsed(id: string): Promise<PasswordResetToken> {
    return this.prisma.passwordResetToken.update({
      where: { id },
      data: { usedAt: new Date() },
    });
  }
}
