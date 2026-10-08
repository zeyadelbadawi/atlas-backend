/**
 * ATO review F1 — an account whose mailbox was never proven must not
 * collect authority somebody else grants to that address.
 *
 * Sign-in does not require a verified address (and the emailed code is a
 * deployment flag), so anyone can register `cfo@victim.example`, choose the
 * password, and sign in. If the real company later adds that address as a
 * Manager — or any academy adds it as a learner — the grant would land on
 * the impostor's account and their session would hold it.
 *
 * The fix sits in the account lifecycle, not in each grant: before a grant
 * made BY SOMEONE ELSE reaches an active account that has never proven its
 * mailbox, every credential that unproven party may have set is withdrawn
 * and the account returns to `invited`. The grant then follows the existing
 * invited-account path: the setup link goes to the mailbox, and only the
 * person who can read it chooses the password. Withdrawn:
 *  - the password and any linked external identity (Google) — sign-in ways
 *    the unproven party chose;
 *  - TOTP enrolment and its recovery codes — otherwise an impostor's
 *    authenticator would lock the real owner out after setup;
 *  - every session and every trusted browser.
 *
 * The same "never proven" rule applies when the mailbox owner first proves
 * control through a password reset (`afterFirstMailboxProof`): sessions and
 * trusted devices already go on every reset; for a never-verified account
 * the sign-in methods the unproven party attached go too.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { SessionRevocationService } from './session-revocation.service';
import { TrustedDeviceService } from './trusted-device.service';
import { PasswordCredentialsService } from './password-credentials.service';

export type UnprovenAccountTrigger = 'unverified_account_grant' | 'first_mailbox_proof';

@Injectable()
export class UnprovenAccountService {
  private readonly logger = new Logger(UnprovenAccountService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly sessionRevocationService: SessionRevocationService,
    private readonly trustedDeviceService: TrustedDeviceService,
    private readonly passwordCredentials: PasswordCredentialsService,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

  /**
   * Returns an active, never-verified account to `invited` before a grant
   * by someone else reaches it. A no-op (returns false) for any account
   * that is not `active` with a null `emailVerifiedAt` — decided by the
   * UPDATE's own WHERE clause, so a concurrent verification wins.
   *
   * Runs in its OWN user-context transaction: the credential tables are
   * owner-only under RLS, so they cannot be written from the granting
   * owner's tenant transaction. Called only after the grant has been
   * authorized; if the grant later fails, the account simply stays
   * `invited` until its mailbox owner sets it up — the safe direction.
   */
  async requireMailboxProofBeforeGrant(userId: string): Promise<boolean> {
    const demoted = await this.tenancyContextService.runInUserContext(
      userId,
      async (tx) => {
        const updated = await tx.user.updateMany({
          where: { id: userId, status: 'active', emailVerifiedAt: null },
          data: { status: 'invited' },
        });
        if (updated.count === 0) return false;
        await this.passwordCredentials.remove(userId, tx);
        await this.removeAttachedSignInMethods(tx, userId);
        return true;
      },
    );
    if (!demoted) return false;
    await this.revokeEverywhere(userId, 'unverified_account_grant');
    return true;
  }

  /**
   * A password reset just proved the mailbox. If the account had NEVER been
   * proven before, the external identities and TOTP on it were attached by
   * whoever held the password without that proof — remove them, and record
   * the address as verified. Returns whether the account was unproven.
   * Sessions and trusted devices are revoked by the reset itself.
   */
  async afterFirstMailboxProof(userId: string, provenAt: Date): Promise<boolean> {
    const wasUnproven = await this.tenancyContextService.runInUserContext(
      userId,
      async (tx) => {
        const updated = await tx.user.updateMany({
          where: { id: userId, emailVerifiedAt: null, status: 'active' },
          data: { emailVerifiedAt: provenAt },
        });
        if (updated.count === 0) return false;
        await this.removeAttachedSignInMethods(tx, userId);
        return true;
      },
    );
    if (wasUnproven) {
      await this.tenancyContextService.runInUserContext(userId, (tx) =>
        this.auditLogWriterService.writeBestEffort(tx, {
          actorUserId: userId,
          action: 'auth.sign_in_methods.removed',
          targetType: 'user',
          targetId: userId,
          context: { trigger: 'first_mailbox_proof' },
        }),
      );
    }
    return wasUnproven;
  }

  private async removeAttachedSignInMethods(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    await tx.userAuthIdentity.deleteMany({ where: { userId } });
    await tx.twoFactorRecoveryCode.deleteMany({ where: { userId } });
    await tx.userTwoFactor.deleteMany({ where: { userId } });
  }

  private async revokeEverywhere(
    userId: string,
    trigger: UnprovenAccountTrigger,
  ): Promise<void> {
    const sessionsRevoked = await this.sessionRevocationService.revokeAllSessionsForUser(
      userId,
      'unverified_account_grant',
    );
    const trustedDevicesRevoked = await this.trustedDeviceService.revokeAllForUser(
      userId,
      trigger,
    );
    this.logger.warn(
      { userId, sessionsRevoked, trustedDevicesRevoked, trigger },
      'Unverified account returned to invited before a grant; credentials withdrawn.',
    );
    await this.tenancyContextService.runInUserContext(userId, (tx) =>
      this.auditLogWriterService.writeBestEffort(tx, {
        actorUserId: userId,
        action: 'auth.sessions.revoked',
        targetType: 'user',
        targetId: userId,
        context: { trigger, sessionsRevoked, trustedDevicesRevoked },
      }),
    );
  }
}
