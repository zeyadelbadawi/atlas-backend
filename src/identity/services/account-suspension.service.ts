/**
 * B0-SEC-07 — the Platform Owner suspends or reinstates a user.
 *
 * `users.status = 'suspended'` has always been honoured (password sign-in,
 * the email-code step, Google sign-in all refuse it), but nothing ever set
 * it: suspending an abusive account needed direct database access, with
 * no audit trail. This is the one supported way, and it:
 *
 * - is Platform Owner only, re-checked here from the database (the route
 *   guard is one edit away from being removed);
 * - refuses the caller's own account and any Platform Owner account, so an
 *   operator cannot lock themselves or another operator out by mistake;
 * - ends every session of the account at once (database rows and the
 *   access-token denylist), so a suspension takes effect immediately
 *   rather than when the current access token expires;
 * - writes an audit row with the operator, the subject and the reason.
 *
 * Organization/academy suspension is out of scope (Deferred): suspending
 * the organization owner already stops all tenant administration.
 */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { SessionRevocationService } from './session-revocation.service';

export interface AccountSuspensionResult {
  readonly status: 'suspended' | 'active';
  readonly sessionsRevoked: number;
}

@Injectable()
export class AccountSuspensionService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly sessionRevocationService: SessionRevocationService,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

  async suspend(
    actorUserId: string,
    targetUserId: string,
    reason: string,
  ): Promise<AccountSuspensionResult> {
    const target = await this.loadTarget(actorUserId, targetUserId);
    if (target.status === 'suspended') {
      return { status: 'suspended', sessionsRevoked: 0 };
    }
    if (target.status !== 'active') {
      throw new ForbiddenException({ messageKey: 'errors.platformUsers.cannotSuspend' });
    }

    await this.tenancyContextService.runInUserContext(targetUserId, (tx) =>
      tx.user.update({ where: { id: targetUserId }, data: { status: 'suspended' } }),
    );
    // After the write: a session minted between the two would otherwise
    // survive. Sign-in refuses `suspended` from here on.
    const sessionsRevoked = await this.sessionRevocationService.revokeAllSessionsForUser(
      targetUserId,
      'account_suspended',
    );
    await this.tenancyContextService.runInUserContext(targetUserId, (tx) =>
      this.auditLogWriterService.writeBestEffort(tx, {
        actorUserId,
        action: 'account.suspended',
        targetType: 'user',
        targetId: targetUserId,
        context: { reason: reason.trim(), sessionsRevoked },
      }),
    );
    return { status: 'suspended', sessionsRevoked };
  }

  async unsuspend(
    actorUserId: string,
    targetUserId: string,
    reason: string | undefined,
  ): Promise<AccountSuspensionResult> {
    const target = await this.loadTarget(actorUserId, targetUserId);
    if (target.status === 'active') return { status: 'active', sessionsRevoked: 0 };
    if (target.status !== 'suspended') {
      throw new ForbiddenException({ messageKey: 'errors.platformUsers.cannotSuspend' });
    }

    await this.tenancyContextService.runInUserContext(targetUserId, async (tx) => {
      await tx.user.update({ where: { id: targetUserId }, data: { status: 'active' } });
      await this.auditLogWriterService.writeBestEffort(tx, {
        actorUserId,
        action: 'account.unsuspended',
        targetType: 'user',
        targetId: targetUserId,
        context: { reason: reason?.trim() || 'not_given' },
      });
    });
    return { status: 'active', sessionsRevoked: 0 };
  }

  private async loadTarget(
    actorUserId: string,
    targetUserId: string,
  ): Promise<{ status: string }> {
    const actor = await this.tenancyContextService.runInUserContext(actorUserId, (tx) =>
      tx.user.findUnique({
        where: { id: actorUserId },
        select: { isPlatformOwner: true },
      }),
    );
    if (!actor?.isPlatformOwner) {
      throw new ForbiddenException({ messageKey: 'errors.forbidden' });
    }
    if (actorUserId === targetUserId) {
      throw new ForbiddenException({
        messageKey: 'errors.platformUsers.cannotSuspendSelf',
      });
    }
    const target = await this.tenancyContextService.runInUserContext(targetUserId, (tx) =>
      tx.user.findUnique({
        where: { id: targetUserId },
        select: { status: true, isPlatformOwner: true },
      }),
    );
    if (!target) throw new NotFoundException({ messageKey: 'errors.notFound' });
    if (target.isPlatformOwner) {
      throw new ForbiddenException({
        messageKey: 'errors.platformUsers.cannotSuspendPlatformOwner',
      });
    }
    return target;
  }
}
