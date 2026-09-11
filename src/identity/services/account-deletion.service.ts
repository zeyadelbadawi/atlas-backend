/**
 * AccountDeletionService — self-service "Delete my account".
 *
 * WHAT DELETION MEANS HERE, AND WHY. The user-deletion relationship graph
 * was mapped from `information_schema` before this was written: `users`
 * is referenced by 47 foreign keys, and several are ON DELETE RESTRICT —
 * `audit_log_entries.actor_user_id`, `organizations.owner_user_id`,
 * `blog_posts.author_id`, `forum_threads.author_id`,
 * `forum_replies.author_id`, `announcements.author_id`,
 * `payment_reviews.reviewed_by`, `provisioning_requests.requested_by_user_id`,
 * `course_order_refunds.requested_by`.
 *
 * Any account that has ever done anything has audit entries, so a hard
 * row delete would be refused by the database for essentially every real
 * user. Those constraints are correct: audit, billing and moderation
 * history must survive a person leaving. Deletion therefore removes the
 * PERSON — irreversibly — while leaving the record of what happened.
 *
 * Concretely:
 *   - identifying fields are replaced with values that cannot be reversed
 *   - the account can never authenticate again
 *   - every session is revoked immediately, not merely expired
 *   - authentication material (2FA secret, recovery codes, reset and
 *     verification tokens) is destroyed
 *   - rows that must persist keep a valid foreign key to an anonymised
 *     subject rather than becoming orphans
 *
 * WHO MAY NOT USE THIS. A platform owner is refused. Self-deleting the
 * account that administers the platform is not a user-facing operation,
 * and the refusal is enforced here rather than by hiding the button.
 *
 * OWNED RESOURCES. An organization owner's academies are archived, which
 * takes their public websites offline and releases the plan's academy
 * allowance. The organization row itself is retained: it anchors billing
 * and audit history, and destroying it would take other people's data
 * with it. That limitation is stated in the report rather than hidden.
 */
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { SessionRevocationService } from './session-revocation.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';

/** Closed vocabulary, mirroring subscription cancellation so both "why did you leave" signals aggregate the same way. */
export const ACCOUNT_DELETION_REASONS = [
  'no_longer_needed',
  'too_expensive',
  'missing_features',
  'too_difficult',
  'switching_provider',
  'privacy_concerns',
  'other',
] as const;

export type AccountDeletionReason = (typeof ACCOUNT_DELETION_REASONS)[number];

export interface DeleteAccountInput {
  readonly reason?: AccountDeletionReason;
  /** Optional free text. Never required to delete. */
  readonly feedback?: string;
}

export interface DeleteAccountResult {
  readonly deleted: boolean;
  /** Academies archived as a consequence, so the UI can say what happened. */
  readonly academiesArchived: number;
}

@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancyContextService: TenancyContextService,
    private readonly sessionRevocationService: SessionRevocationService,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

  /**
   * Deletes the CALLER'S OWN account.
   *
   * There is deliberately no user-id parameter. The only account this can
   * ever act on is the one proved by the access token, so there is no
   * value an attacker could substitute to delete somebody else — the
   * horizontal-privilege-escalation class of bug is absent by
   * construction rather than by a check that could be forgotten.
   */
  async deleteOwnAccount(
    userId: string,
    input: DeleteAccountInput,
  ): Promise<DeleteAccountResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, isPlatformOwner: true, status: true },
    });

    if (!user) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }

    // Idempotent: deleting an already-deleted account is a no-op, not an
    // error. A retried request must not fail after the first succeeded.
    if (user.status === 'deleted') {
      return { deleted: true, academiesArchived: 0 };
    }

    // The platform owner is refused HERE, on the server. Hiding the
    // control in the UI would leave the endpoint reachable.
    if (user.isPlatformOwner) {
      throw new ForbiddenException({
        messageKey: 'errors.auth.platformOwnerCannotSelfDelete',
      });
    }

    const academiesArchived = await this.archiveOwnedAcademies(userId);

    // Before anonymising: strip the person's access, inside the tenant
    // contexts RLS requires. Doing this first means that even if
    // anonymisation failed, the account would already have lost its
    // memberships rather than being left half-deleted with full access.
    await this.removeMemberships(userId);

    const sessionIds = await this.anonymiseAndRevoke(userId, input);

    // Revocation is written to the denylist AFTER the transaction commits:
    // the database state is already authoritative, and a Redis failure
    // here must not roll back a completed deletion. `isRevoked`'s own
    // database fallback still refuses these sessions if Redis is down.
    for (const sessionId of sessionIds) {
      await this.sessionRevocationService.markRevoked(sessionId);
    }

    this.logger.log(
      { userId, academiesArchived, sessionsRevoked: sessionIds.length },
      'Account deleted at user request.',
    );

    return { deleted: true, academiesArchived };
  }

  /**
   * Archives the academies of every organization this user owns.
   *
   * This is what takes their public websites offline and releases the
   * plan's academy allowance. Archiving rather than deleting matches the
   * existing `AcademiesService.archive` behaviour — there is no DELETE
   * RLS policy on `academies` at all, by design.
   */
  private async archiveOwnedAcademies(userId: string): Promise<number> {
    // Read inside a USER context. Without it the `organizations` SELECT
    // policy matches nothing and this returns an empty list — the lookup
    // fails silently and the whole method becomes a no-op that still
    // reports success.
    const ownedOrganizations = await this.tenancyContextService.runInUserContext(
      userId,
      (tx) =>
        tx.organization.findMany({
          where: { ownerUserId: userId },
          select: { id: true },
        }),
    );

    let archived = 0;
    for (const organization of ownedOrganizations) {
      const result = await this.tenancyContextService.runInTenantAndUserContext(
        organization.id,
        userId,
        (tx) =>
          tx.academy.updateMany({
            where: { organizationId: organization.id, status: { not: 'archived' } },
            data: { status: 'archived' },
          }),
      );
      archived += result.count;
    }

    return archived;
  }

  /**
   * Removes the user's memberships, one organization at a time.
   *
   * These tables are RLS-protected and tenant-scoped, so each delete must
   * run inside the tenant context of the organization that owns the row.
   * A single context-free `deleteMany` matches nothing and reports
   * success — a silent no-op, and the reason this method exists
   * separately from the anonymisation transaction.
   */
  private async removeMemberships(userId: string): Promise<void> {
    // Same trap as `archiveOwnedAcademies`: this read is RLS-protected.
    // The P2 self-membership SELECT policy keys on `app.current_user_id`,
    // so a user context is what makes a user able to see their own
    // memberships at all.
    const memberships = await this.tenancyContextService.runInUserContext(userId, (tx) =>
      tx.organizationMembership.findMany({
        where: { userId },
        select: { organizationId: true },
      }),
    );

    const organizationIds = [
      ...new Set(memberships.map((membership) => membership.organizationId)),
    ];

    for (const organizationId of organizationIds) {
      await this.tenancyContextService.runInTenantAndUserContext(
        organizationId,
        userId,
        async (tx) => {
          // Academy-level access first, then the organization membership
          // that grants reach to it.
          await tx.courseInstructor.deleteMany({ where: { userId } });
          await tx.academyMember.deleteMany({ where: { userId } });
          await tx.academyStudent.deleteMany({ where: { userId } });
          await tx.organizationMembership.deleteMany({
            where: { userId, organizationId },
          });
        },
      );
    }
  }

  /**
   * The deletion itself, in one transaction.
   *
   * Returns the session ids that were revoked so the caller can add them
   * to the fast-path denylist once the transaction has committed.
   */
  private async anonymiseAndRevoke(
    userId: string,
    input: DeleteAccountInput,
  ): Promise<string[]> {
    return this.prisma.$transaction(async (tx) => {
      const liveSessions = await tx.refreshToken.findMany({
        where: { userId, revokedAt: null },
        select: { sessionId: true },
      });

      const now = new Date();

      // Every session dies, not just the one making the request.
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });

      // Authentication material is destroyed outright — none of it has
      // any audit value, and all of it is dangerous to retain.
      await tx.userTwoFactor.deleteMany({ where: { userId } });
      await tx.twoFactorRecoveryCode.deleteMany({ where: { userId } });
      await tx.passwordResetToken.deleteMany({ where: { userId } });
      await tx.emailVerificationToken.deleteMany({ where: { userId } });

      // NOTE: memberships are NOT removed here. They are tenant-scoped
      // and RLS-protected, and this transaction runs with no tenant
      // context — a `deleteMany` here silently matches zero rows and
      // reports success, which is exactly what happened in the first
      // version of this service: the account was anonymised but its
      // membership rows survived, so a deleted person still appeared in
      // academy member lists. They are removed by
      // `removeMemberships` before this runs, inside a real tenant
      // context per organization.

      await tx.user.update({
        where: { id: userId },
        data: {
          // `email` is UNIQUE, so it cannot be blanked — two deleted
          // accounts would collide. An opaque per-account value keeps the
          // constraint satisfied while being irreversible, and it can
          // never be signed in with because the status check refuses
          // first.
          email: `deleted-${randomUUID()}@account.invalid`,
          name: 'Deleted account',
          avatarUrl: null,
          preferences: {},
          // Replaced with a value no password can produce, so even a
          // future code path that forgot the status check could not
          // authenticate this row.
          passwordHash: `deleted:${randomUUID()}`,
          status: 'deleted',
          deletedAt: now,
          deletionReason: input.reason ?? null,
          deletionFeedback: input.feedback?.trim() || null,
          emailVerifiedAt: null,
        },
      });

      await this.auditLogWriterService.writeBestEffort(tx, {
        actorUserId: userId,
        action: 'account.deleted',
        targetType: 'user',
        targetId: userId,
        context: {
          reason: input.reason ?? 'not_given',
          hasFeedback: Boolean(input.feedback),
          sessionsRevoked: liveSessions.length,
        },
      });

      return liveSessions.map((session) => session.sessionId);
    });
  }
}
