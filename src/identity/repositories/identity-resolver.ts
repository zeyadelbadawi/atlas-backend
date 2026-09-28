/**
 * IdentityResolver — the ONLY pre-authentication crossing into the identity
 * tables (authentication audit, Decision 2).
 *
 * `users` and the six credential tables carry FORCE ROW LEVEL SECURITY
 * (`20261021000000_identity_tables_rls`): a credential row is visible only in
 * its owner's `app.current_user_id` context, and a `users` row only inside
 * an established context. A sign-in, a refresh, a reset or a verification
 * arrives with no context — it presents an email, a token or a federated
 * subject. This class turns that key into the OWNER'S ID through the
 * migration's narrow SECURITY DEFINER functions, which return an id and
 * nothing else; every read and write that follows runs in that owner's own
 * context under the ordinary policies.
 *
 * Keep every call to those functions in this file, so the entire
 * pre-authentication surface is one reviewable place.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class IdentityResolver {
  constructor(private readonly prisma: PrismaService) {}

  /** The account an (already normalised) email names, or null. */
  async userIdByEmail(email: string): Promise<string | null> {
    return this.scalar(
      this.prisma.$queryRaw<{ id: string | null }[]>`
        SELECT auth_user_id_by_email(${email}) AS id`,
    );
  }

  /** The owner of a refresh token, by the SHA-256 the client's token hashes to. */
  async refreshTokenOwner(tokenHash: string): Promise<string | null> {
    return this.scalar(
      this.prisma.$queryRaw<{ id: string | null }[]>`
        SELECT auth_refresh_token_owner(${tokenHash}) AS id`,
    );
  }

  /** The owner of a password-reset / account-setup token, by its hash. */
  async passwordResetTokenOwner(tokenHash: string): Promise<string | null> {
    return this.scalar(
      this.prisma.$queryRaw<{ id: string | null }[]>`
        SELECT auth_password_reset_token_owner(${tokenHash}) AS id`,
    );
  }

  /** The owner of an email-verification token, by its hash. */
  async emailVerificationTokenOwner(tokenHash: string): Promise<string | null> {
    return this.scalar(
      this.prisma.$queryRaw<{ id: string | null }[]>`
        SELECT auth_email_verification_token_owner(${tokenHash}) AS id`,
    );
  }

  /** The account a federated identity (provider + stable subject) is linked to. */
  async identityOwner(provider: 'google', subject: string): Promise<string | null> {
    return this.scalar(
      this.prisma.$queryRaw<{ id: string | null }[]>`
        SELECT auth_identity_owner(${provider}, ${subject}) AS id`,
    );
  }

  /**
   * One platform-owner id, for background jobs that act under the Platform
   * Owner context (retention sweeps, provider webhooks). Any one will do:
   * `is_platform_owner(uid)` only checks the flag on that row.
   */
  async platformOwnerId(): Promise<string | null> {
    return this.scalar(
      this.prisma.$queryRaw<{ id: string | null }[]>`
        SELECT platform_owner_user_id() AS id`,
    );
  }

  private async scalar(query: Promise<{ id: string | null }[]>): Promise<string | null> {
    const rows = await query;
    return rows[0]?.id ?? null;
  }
}
