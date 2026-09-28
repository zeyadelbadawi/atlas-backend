/**
 * EmailVerificationTokensRepository.
 *
 * `claim()` is the security-critical method — see its doc comment.
 * Deliberately mirrors `PasswordResetTokensRepository`: same hashed-token
 * storage, same single-use semantics, same "never look up by raw token"
 * discipline.
 *
 * Authentication audit, Decision 2 — the table is strictly per-user under
 * RLS; `claim` finds the owner by the token's hash through
 * `IdentityResolver`, and every statement runs in the owner's context.
 */
import { Injectable } from '@nestjs/common';
import type { EmailVerificationToken, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { runInUserContext } from '../../database/user-context';
import { IdentityResolver } from './identity-resolver';

export interface CreateEmailVerificationTokenInput {
  readonly userId: string;
  /** Already hashed by the caller. A raw token must never reach this layer. */
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

@Injectable()
export class EmailVerificationTokensRepository {
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

  create(input: CreateEmailVerificationTokenInput): Promise<EmailVerificationToken> {
    return this.asUser(input.userId, (tx) =>
      tx.emailVerificationToken.create({ data: { ...input } }),
    );
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
    const ownerId = await this.identityResolver.emailVerificationTokenOwner(tokenHash);
    if (!ownerId) return null;
    const now = new Date();
    return this.asUser(ownerId, async (tx) => {
      const claim = await tx.emailVerificationToken.updateMany({
        where: { tokenHash, userId: ownerId, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });

      if (claim.count !== 1) return null;

      return tx.emailVerificationToken.findUnique({ where: { tokenHash } });
    });
  }

  /**
   * Invalidates every outstanding token for a user.
   *
   * Called before issuing a new one, so re-requesting verification never
   * leaves an older link live. Marking them used (rather than deleting)
   * keeps the audit trail of how many were issued.
   */
  async invalidateAllForUser(userId: string): Promise<void> {
    await this.asUser(userId, (tx) =>
      tx.emailVerificationToken.updateMany({
        where: { userId, usedAt: null },
        data: { usedAt: new Date() },
      }),
    );
  }
}
