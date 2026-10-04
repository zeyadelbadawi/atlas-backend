/**
 * UsersRepository — the only place `prisma.user.*` is called from.
 *
 * Matches the master plan §11 "Repository / Data Access" layer: services
 * decide business rules, repositories only talk to Postgres.
 *
 * Authentication audit, Decision 2 — `users` carries FORCE ROW LEVEL
 * SECURITY: a row is readable only inside an established context and
 * writable only by its own account (or the Platform Owner). So every method
 * here that is given an id runs in THAT account's own context, a lookup by
 * email first learns the id through `IdentityResolver`, and a new account is
 * inserted in the context of its own pre-generated id. A caller that passes
 * its own `client` brings its own context (the staff member-add path creates
 * an `invited` account inside its tenant context).
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma, User, UserAccountStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { runInUserContext } from '../../database/user-context';
import { normalizeEmail } from '../utils/email.util';
import { IdentityResolver } from './identity-resolver';

export interface CreateUserInput {
  readonly email: string;
  readonly name: string;
  /**
   * Launch Stabilization A2 (D2) — `invited` for an account somebody else
   * created: it cannot sign in until its owner sets a password through the
   * emailed setup link. Omitted = the schema default, `active`.
   */
  readonly status?: UserAccountStatus;
}

export interface UpdateProfileInput {
  readonly name?: string;
  readonly avatarUrl?: string;
}

@Injectable()
export class UsersRepository {
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

  /**
   * `client` lets a caller run the lookup inside its own transaction (the
   * staff member-add path creates the user and the membership atomically);
   * that transaction's context must already be established. Without one,
   * the owner is resolved by email and read in its own context.
   */
  async findByEmail(
    email: string,
    client?: Prisma.TransactionClient,
  ): Promise<User | null> {
    const normalized = normalizeEmail(email);
    if (client) return client.user.findUnique({ where: { email: normalized } });
    const id = await this.identityResolver.userIdByEmail(normalized);
    if (!id) return null;
    return this.findById(id);
  }

  findById(id: string): Promise<User | null> {
    return this.asUser(id, (tx) => tx.user.findUnique({ where: { id } }));
  }

  create(input: CreateUserInput, client?: Prisma.TransactionClient): Promise<User> {
    const id = randomUUID();
    const write = (tx: Prisma.TransactionClient) =>
      tx.user.create({
        data: {
          id,
          email: normalizeEmail(input.email),
          name: input.name,
          // `status` defaults to 'active' per the schema. Launch Stabilization
          // A2 writes `invited` for staff-created accounts.
          ...(input.status ? { status: input.status } : {}),
        },
      });
    return client ? write(client) : this.asUser(id, write);
  }

  /** `client` — W4: a rename runs inside the caller's transaction (its learner-name checks and locks). */
  updateProfile(
    id: string,
    input: UpdateProfileInput,
    client?: Prisma.TransactionClient,
  ): Promise<User> {
    const write = (tx: Prisma.TransactionClient) =>
      tx.user.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
        },
      });
    return client ? write(client) : this.asUser(id, write);
  }

  /** Phase 10.1 — records that this address proved it can receive mail. */
  markEmailVerified(id: string, verifiedAt: Date): Promise<User> {
    return this.asUser(id, (tx) =>
      tx.user.update({
        where: { id },
        data: { emailVerifiedAt: verifiedAt },
      }),
    );
  }

  /**
   * Launch Stabilization A2 (D2) — the owner of an `invited` account has
   * just set their own password through the emailed setup/reset link: the
   * account becomes usable, and the address is proven (the link was
   * delivered to it). A no-op for any other status.
   */
  async completeInvitation(id: string, verifiedAt: Date): Promise<void> {
    // Only an `invited` account changes, in one statement: every other
    // account (including legacy staff-created `active` ones) keeps its
    // status and verification state exactly as a reset always left them.
    await this.asUser(id, (tx) =>
      tx.user.updateMany({
        where: { id, status: 'invited' },
        data: { status: 'active', emailVerifiedAt: verifiedAt },
      }),
    );
  }

  touchLastSignInAt(id: string): Promise<User> {
    return this.asUser(id, (tx) =>
      tx.user.update({ where: { id }, data: { lastSignInAt: new Date() } }),
    );
  }

  /**
   * Phase 2 — the one id a genuine background system job (the trial-
   * expiry/usage-recompute sweep, `SubscriptionSweepService`) needs to
   * open a legitimate `runInUserContext` under, so it can use the
   * existing Platform Owner cross-tenant RLS bypass
   * (`organizations_platform_select`/`tenant_subscriptions_platform_select`
   * /`_platform_update`, P15) exactly like every real Platform Owner
   * request already does — never a second, parallel "system" bypass
   * mechanism. Which specific platform owner is returned does not matter:
   * `is_platform_owner(uid)` only checks the boolean flag on that one row,
   * so any user with `isPlatformOwner: true` satisfies every policy this
   * job relies on identically. A context-less job cannot read `users`
   * under RLS, so the id comes from the `platform_owner_user_id()`
   * resolver (ids only).
   */
  async findFirstPlatformOwnerId(): Promise<Pick<User, 'id'> | null> {
    const id = await this.identityResolver.platformOwnerId();
    return id ? { id } : null;
  }

  /**
   * Atomically shallow-merges `partial` into the stored `preferences` JSONB
   * document using Postgres's `||` jsonb concatenation operator, so two
   * concurrent preference updates for the same user can never lose one
   * write to a read-modify-write race. Parameters are bound (not
   * interpolated), so this is not a SQL-injection surface despite being raw
   * SQL — Prisma's tagged-template `$executeRaw` parameterizes every `${}`.
   */
  async mergePreferences(id: string, partial: Record<string, unknown>): Promise<User> {
    return this.asUser(id, async (tx) => {
      await tx.$executeRaw`
        UPDATE users
        SET preferences = preferences || ${JSON.stringify(partial)}::jsonb,
            updated_at = now()
        WHERE id = ${id}
      `;
      return tx.user.findUniqueOrThrow({ where: { id } });
    });
  }
}
