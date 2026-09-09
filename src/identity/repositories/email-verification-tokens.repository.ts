/**
 * EmailVerificationTokensRepository.
 *
 * `claim()` is the security-critical method — see its doc comment.
 * Deliberately mirrors `PasswordResetTokensRepository`: same hashed-token
 * storage, same single-use semantics, same "never look up by raw token"
 * discipline.
 */
import { Injectable } from '@nestjs/common';
import type { EmailVerificationToken } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export interface CreateEmailVerificationTokenInput {
  readonly userId: string;
  /** Already hashed by the caller. A raw token must never reach this layer. */
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

@Injectable()
export class EmailVerificationTokensRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateEmailVerificationTokenInput): Promise<EmailVerificationToken> {
    return this.prisma.emailVerificationToken.create({ data: { ...input } });
  }

  /**
   * Atomically consumes a verification token.
   *
   * The `updateMany` is a compare-and-swap: it matches only a row that is
   * unused AND unexpired, and stamps `usedAt` in the same statement.
   * Postgres takes a row lock, so two concurrent submissions of the same
   * link serialise and exactly one sees `count === 1` — the other matches
   * zero rows. That is what makes replay impossible, rather than a
   * read-then-write check that a second request could slip between.
   *
   * @returns the claimed token when this caller won, `null` for every
   *          failure mode (unknown, expired, already used) — the caller
   *          collapses them all into one generic error so the endpoint
   *          cannot be used to probe which tokens exist.
   */
  async claim(tokenHash: string): Promise<EmailVerificationToken | null> {
    const now = new Date();
    const claim = await this.prisma.emailVerificationToken.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });

    if (claim.count !== 1) return null;

    return this.prisma.emailVerificationToken.findUnique({ where: { tokenHash } });
  }

  /**
   * Invalidates every outstanding token for a user.
   *
   * Called before issuing a new one, so re-requesting verification never
   * leaves an older link live. Marking them used (rather than deleting)
   * keeps the audit trail of how many were issued.
   */
  async invalidateAllForUser(userId: string): Promise<void> {
    await this.prisma.emailVerificationToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    });
  }
}
