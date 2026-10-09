/**
 * EmailVerificationTokensRepository.
 *
 * `consume()` and `rotateForUser()` are the security-critical methods —
 * see their doc comments. Deliberately mirrors
 * `PasswordResetTokensRepository`: same hashed-token storage, same
 * single-use semantics, same "never look up by raw token" discipline.
 *
 * Authentication audit, Decision 2 — the table is strictly per-user under
 * RLS; `consume` finds the owner by the token's hash through
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

/** What one verification attempt came to. See `consume` for when each is reported. */
export type EmailVerificationOutcome =
  | { readonly status: 'verified'; readonly userId: string }
  | { readonly status: 'invalid' | 'expired' | 'used' | 'signInRequired' };

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
   * Atomically consumes a verification token AND marks the address
   * verified — one transaction, so a crash between the two can never
   * burn the link while leaving the account unverified.
   *
   * The `updateMany` is a compare-and-swap: it matches only a row that is
   * unused AND unexpired, and stamps `usedAt` in the same statement.
   * Postgres takes a row lock, so two concurrent submissions of the same
   * link serialise and exactly one sees `count === 1` — the other matches
   * zero rows. That is what makes replay impossible, rather than a
   * read-then-write check that a second request could slip between.
   * `emailVerifiedAt` is only ever set when still null, so the first
   * proof's timestamp is kept (an OTP sign-in may have set it already).
   *
   * Failure reasons beyond `invalid` are reported ONLY once the hash has
   * matched a real row — i.e. only to whoever holds the emailed link. An
   * unknown hash is `invalid`, exactly like a malformed token the caller
   * never hashed, so nothing here helps anyone probe which tokens exist.
   * A token retired by a newer resend is stamped used without the address
   * being verified; that reads as `expired` ("request a new one"), and
   * `used` is reserved for a link whose account is in fact verified.
   */
  /**
   * Claims the link for its owner — only when the caller is signed in AS
   * that owner (`callerUserId`).
   *
   * ATO F1 follow-up: a verified address is what lets an account receive
   * roles granted to that address (`UnprovenAccountService`). If a click
   * from anyone could verify, someone who pre-registered a victim's address
   * would only need the victim (or a mail scanner) to open the link to make
   * the squatted account "proven". The link therefore proves the mailbox
   * only together with the account's own session. A live link opened
   * without that session is NOT spent — `signInRequired` — so the real
   * owner can sign in and finish; only the holder of a real link ever
   * learns this, malformed/unknown tokens stay plain `invalid`.
   */
  async consume(
    tokenHash: string,
    callerUserId: string | null,
  ): Promise<EmailVerificationOutcome> {
    const ownerId = await this.identityResolver.emailVerificationTokenOwner(tokenHash);
    if (!ownerId) return { status: 'invalid' };
    const now = new Date();
    return this.asUser(ownerId, async (tx): Promise<EmailVerificationOutcome> => {
      if (callerUserId !== ownerId) {
        const live = await tx.emailVerificationToken.findFirst({
          where: { tokenHash, userId: ownerId, usedAt: null, expiresAt: { gt: now } },
          select: { id: true },
        });
        if (live) return { status: 'signInRequired' };
        return this.spentOutcome(tx, tokenHash, ownerId);
      }
      const claim = await tx.emailVerificationToken.updateMany({
        where: { tokenHash, userId: ownerId, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });

      if (claim.count === 1) {
        await tx.user.updateMany({
          where: { id: ownerId, emailVerifiedAt: null },
          data: { emailVerifiedAt: now },
        });
        return { status: 'verified', userId: ownerId };
      }

      return this.spentOutcome(tx, tokenHash, ownerId);
    });
  }

  /** Why a real link can no longer be claimed: it expired, or it was used. */
  private async spentOutcome(
    tx: Prisma.TransactionClient,
    tokenHash: string,
    ownerId: string,
  ): Promise<EmailVerificationOutcome> {
    const token = await tx.emailVerificationToken.findUnique({
      where: { tokenHash },
      select: { usedAt: true },
    });
    if (!token) return { status: 'invalid' };
    if (!token.usedAt) return { status: 'expired' };
    const owner = await tx.user.findUnique({
      where: { id: ownerId },
      select: { emailVerifiedAt: true },
    });
    return owner?.emailVerifiedAt ? { status: 'used' } : { status: 'expired' };
  }

  /**
   * Replaces the account's live link with a new one, inside the CALLER's
   * user-context transaction (so the outbox entry carrying the new link
   * commits with it, or neither does).
   *
   * The user row is locked first (`SELECT … FOR UPDATE`), which serialises
   * every rotation for one account: two concurrent resends cannot both
   * invalidate-then-insert against the same snapshot and leave two live
   * tokens behind. The second waits for the first to commit, and its
   * invalidation — a new statement, so a new READ COMMITTED snapshot —
   * then retires the token the first one just created. Retired tokens are
   * stamped used rather than deleted, keeping the trail of what was issued.
   *
   * @returns `false`, writing nothing, when the account is gone or already
   *          verified — checked under the same lock, so a verification
   *          that commits first is never followed by a pointless new link.
   */
  async rotateForUser(
    tx: Prisma.TransactionClient,
    input: CreateEmailVerificationTokenInput,
  ): Promise<boolean> {
    const locked = await tx.$queryRaw<{ email_verified_at: Date | null }[]>`
      SELECT "email_verified_at" FROM "users" WHERE "id" = ${input.userId} FOR UPDATE`;
    if (locked.length === 0 || locked[0].email_verified_at) return false;
    await tx.emailVerificationToken.updateMany({
      where: { userId: input.userId, usedAt: null },
      data: { usedAt: new Date() },
    });
    await tx.emailVerificationToken.create({ data: { ...input } });
    return true;
  }
}
