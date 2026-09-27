/**
 * Google Identity — persistence for `auth_oauth_flows` and
 * `user_auth_identities`. Every "spend" of a flow secret is ONE conditional
 * UPDATE, so of two concurrent callbacks or completions exactly one wins and
 * the other matches nothing.
 */
import { Injectable } from '@nestjs/common';
import type { AuthOAuthFlow, Prisma, User, UserAuthIdentity } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export interface CreateFlowInput {
  readonly stateHash: string;
  readonly nonceHash: string;
  readonly binderHash: string;
  readonly codeVerifier: string;
  readonly intent: string;
  readonly surface: 'management' | 'academy';
  readonly academyId: string | null;
  readonly originHost: string;
  readonly returnPath: string | null;
  readonly linkUserId?: string | null;
  readonly ipAddress: string | null;
  readonly expiresAt: Date;
}

export interface FlowClaimsInput {
  readonly providerSubject: string;
  readonly providerEmail: string;
  readonly providerEmailVerified: boolean;
  readonly providerHostedDomain: string | null;
  readonly providerName: string | null;
}

@Injectable()
export class GoogleIdentityRepository {
  constructor(private readonly prisma: PrismaService) {}

  createFlow(input: CreateFlowInput): Promise<AuthOAuthFlow> {
    return this.prisma.authOAuthFlow.create({
      data: { provider: 'google', ...input, linkUserId: input.linkUserId ?? null },
    });
  }

  /**
   * Spends a state: the one callback that matches an unexpired, never-used
   * state gets the row; a replay, an unknown or an expired state gets null.
   */
  async claimState(stateHash: string, now: Date): Promise<AuthOAuthFlow | null> {
    const claimed = await this.prisma.authOAuthFlow.updateMany({
      where: { stateHash, callbackAt: null, expiresAt: { gt: now } },
      data: { callbackAt: now },
    });
    if (claimed.count !== 1) return null;
    return this.prisma.authOAuthFlow.findUnique({ where: { stateHash } });
  }

  /** Records the verified provider claims and the next single-use secret. */
  async recordClaims(
    id: string,
    claims: FlowClaimsInput,
    handoff: { readonly hash: string; readonly expiresAt: Date },
  ): Promise<void> {
    await this.prisma.authOAuthFlow.update({
      where: { id },
      data: {
        ...claims,
        handoffHash: handoff.hash,
        handoffExpiresAt: handoff.expiresAt,
        handedOffAt: null,
      },
    });
  }

  /**
   * Spends a handoff (or a follow-up step's pending secret, which lives in
   * the same column): exactly one completion wins.
   */
  async claimHandoff(handoffHash: string, now: Date): Promise<AuthOAuthFlow | null> {
    const claimed = await this.prisma.authOAuthFlow.updateMany({
      where: {
        handoffHash,
        handedOffAt: null,
        completedAt: null,
        handoffExpiresAt: { gt: now },
      },
      data: { handedOffAt: now },
    });
    if (claimed.count !== 1) return null;
    return this.prisma.authOAuthFlow.findUnique({ where: { handoffHash } });
  }

  /** A follow-up step (link / create / activate) gets a fresh single-use secret. */
  async reissuePending(
    id: string,
    pending: { readonly hash: string; readonly expiresAt: Date },
  ): Promise<void> {
    await this.prisma.authOAuthFlow.update({
      where: { id },
      data: {
        handoffHash: pending.hash,
        handoffExpiresAt: pending.expiresAt,
        handedOffAt: null,
      },
    });
  }

  /**
   * A follow-up step that failed for a reason the person can fix (a wrong
   * password) gives its pending secret back, so they can try again within
   * its lifetime instead of going through Google again. Bounded by the
   * sign-in budget of the step itself.
   */
  async releaseHandoff(id: string): Promise<void> {
    await this.prisma.authOAuthFlow.updateMany({
      where: { id, completedAt: null },
      data: { handedOffAt: null },
    });
  }

  async markCompleted(id: string, now: Date): Promise<void> {
    await this.prisma.authOAuthFlow.updateMany({
      where: { id, completedAt: null },
      data: { completedAt: now },
    });
  }

  findIdentity(
    subject: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<(UserAuthIdentity & { user: User }) | null> {
    return client.userAuthIdentity.findUnique({
      where: {
        provider_providerSubject: { provider: 'google', providerSubject: subject },
      },
      include: { user: true },
    });
  }

  findIdentityForUser(userId: string): Promise<UserAuthIdentity | null> {
    return this.prisma.userAuthIdentity.findUnique({
      where: { userId_provider: { userId, provider: 'google' } },
    });
  }

  /**
   * Binds a Google identity to an account. Inside the caller's transaction;
   * the two unique indexes decide every race (P2002 for the caller to map).
   */
  createIdentity(
    tx: Prisma.TransactionClient,
    input: { readonly userId: string; readonly subject: string; readonly email: string },
  ): Promise<UserAuthIdentity> {
    return tx.userAuthIdentity.create({
      data: {
        userId: input.userId,
        provider: 'google',
        providerSubject: input.subject,
        emailAtLink: input.email,
        lastUsedAt: new Date(),
      },
    });
  }

  async deleteIdentityForUser(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<UserAuthIdentity | null> {
    const existing = await tx.userAuthIdentity.findUnique({
      where: { userId_provider: { userId, provider: 'google' } },
    });
    if (!existing) return null;
    await tx.userAuthIdentity.delete({ where: { id: existing.id } });
    return existing;
  }

  /** Display-only refresh: the address Google reports today, and when it was used. */
  async touchIdentity(id: string, email: string, now: Date): Promise<void> {
    await this.prisma.userAuthIdentity.update({
      where: { id },
      data: { lastUsedAt: now, emailAtLink: email },
    });
  }
}
