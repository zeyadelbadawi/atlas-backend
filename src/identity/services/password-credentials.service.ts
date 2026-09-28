/**
 * PasswordCredentialsService — the ONLY code that reads or writes an
 * account's password credential (production-readiness pass).
 *
 * The Argon2 hash lives in `user_credentials`, not on the `users` directory
 * row, under FORCE ROW LEVEL SECURITY that admits a row only in its owner's
 * own `app.current_user_id` context. Every statement here runs in that
 * context. The hash never leaves this class: callers get a boolean.
 *
 * ONE VERIFICATION PATH. Every place that checks a password — sign-in,
 * academy join, the academy-signup join, TOTP disable / recovery codes,
 * password change, Google link / unlink — calls `verify` or
 * `verifyForUnknownAccount`. Both spend exactly one Argon2 verification, so an
 * unknown email, an account without a password (Google-only, invited,
 * deleted) and a wrong password take the same time.
 *
 * No row = no password. There is no sentinel string: "has a usable password"
 * is the existence of a row.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { runInUserContext } from '../../database/user-context';
import { PasswordHasherService } from './password-hasher.service';

/** An Argon2 PHC string produced by `hashNew` — branded so a plaintext can never be stored by mistake. */
export type HashedPassword = string & { readonly __brand: 'HashedPassword' };

/** A value nobody can ever sign in with — only ever verified against, for timing. */
const DUMMY_PASSWORD = 'atlas-credential-dummy-password-for-timing-safety-only';

@Injectable()
export class PasswordCredentialsService {
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordHasher: PasswordHasherService,
  ) {}

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.passwordHasher.hash(DUMMY_PASSWORD);
    return this.dummyHash;
  }

  private read(
    userId: string,
    client?: Prisma.TransactionClient,
  ): Promise<string | null> {
    const query = (tx: Prisma.TransactionClient) =>
      tx.userCredential
        .findUnique({ where: { userId }, select: { passwordHash: true } })
        .then((row) => row?.passwordHash ?? null);
    return client ? query(client) : runInUserContext(this.prisma, userId, query);
  }

  /**
   * Whether `password` is this account's password. An account with no
   * credential spends the same Argon2 work against a dummy hash and answers
   * false.
   */
  async verify(userId: string, password: string): Promise<boolean> {
    const hash = await this.read(userId);
    if (!hash) {
      await this.passwordHasher.verify(await this.getDummyHash(), password);
      return false;
    }
    return this.passwordHasher.verify(hash, password);
  }

  /** The same Argon2 work as `verify`, for an email that names no account. Always false. */
  async verifyForUnknownAccount(password: string): Promise<false> {
    await this.passwordHasher.verify(await this.getDummyHash(), password);
    return false;
  }

  /** The same Argon2 work as setting a password, for a decoy path that must not be faster. */
  async hashDecoy(password: string): Promise<void> {
    await this.passwordHasher.hash(password);
  }

  /** Whether the account has a password its owner can use. */
  async has(userId: string): Promise<boolean> {
    return (await this.read(userId)) !== null;
  }

  /**
   * Hashes a new password OUTSIDE any transaction (Argon2 takes tens of
   * milliseconds; a transaction should not hold a connection for it). Pass
   * the result to `storeHashed` inside the caller's transaction.
   */
  hashNew(password: string): Promise<HashedPassword> {
    return this.passwordHasher.hash(password) as Promise<HashedPassword>;
  }

  /**
   * Stores an already-hashed password inside the caller's transaction, which
   * must already be in this account's own user context.
   */
  async storeHashed(
    tx: Prisma.TransactionClient,
    userId: string,
    passwordHash: HashedPassword,
  ): Promise<void> {
    await tx.userCredential.upsert({
      where: { userId },
      create: { userId, passwordHash },
      update: { passwordHash },
    });
  }

  /** Sets (or replaces) the account's password, in its own context. */
  async set(userId: string, password: string): Promise<void> {
    const passwordHash = await this.hashNew(password);
    await runInUserContext(this.prisma, userId, (tx) =>
      this.storeHashed(tx, userId, passwordHash),
    );
  }

  /** Removes the password (Google-only activation, deletion). Idempotent. */
  async remove(userId: string, client?: Prisma.TransactionClient): Promise<void> {
    const write = (tx: Prisma.TransactionClient) =>
      tx.userCredential.deleteMany({ where: { userId } });
    await (client ? write(client) : runInUserContext(this.prisma, userId, write));
  }
}
