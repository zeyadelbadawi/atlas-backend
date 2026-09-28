/**
 * AccountDeletionService — the one implementation of "delete this
 * account", reached either by the account holder or by a Platform Owner.
 *
 * WHAT DELETION MEANS HERE, AND WHY. The user-deletion relationship graph
 * was mapped from `information_schema` before this was written: `users`
 * is referenced by 53 foreign keys, and TEN are ON DELETE RESTRICT —
 * `audit_log_entries.actor_user_id`, `organizations.owner_user_id`,
 * `blog_posts.author_id`, `forum_threads.author_id`,
 * `forum_replies.author_id`, `announcements.author_id`,
 * `payment_reviews.reviewed_by`, `provisioning_requests.requested_by_user_id`,
 * `course_order_refunds.requested_by`, `live_sessions.host_user_id`.
 *
 * (This list said nine until 25 Sep 2026. `live_sessions.host_user_id`
 * arrived with P44, after the count was written, and the omission was
 * found while mapping the graph again for the deletion programme. The
 * conclusion below was never affected — one RESTRICT edge is already
 * enough to make a hard delete impossible — but a stale number in the
 * explanation of a security-relevant design is worth correcting.)
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
 * WHO MAY NOT BE DELETED. A platform owner, through either door. Nothing
 * in the product can grant `is_platform_owner` back — only a provisioning
 * script with database access can — so deleting one is a step that cannot
 * be undone from inside Atlas. The refusal is enforced here, on the
 * server, rather than by hiding a button.
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
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  CERTIFICATE_ANONYMIZE_JOB,
  CERTIFICATE_JOBS_QUEUE,
  type CertificateAnonymizeJobPayload,
} from '../../certificates/queue/certificate-jobs.types';
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

/**
 * Who asked, which the audit row must record faithfully.
 *
 * "This person left" and "an operator removed this person" are different
 * events with different accountability, and an audit trail that collapsed
 * them would lose the only fact that distinguishes them.
 */
export interface DeletionActor {
  /** The account that authorised it — the subject themselves, or an operator. */
  readonly actorUserId: string;
  readonly initiatedBy: 'self' | 'platform_owner';
}

@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    @InjectQueue(CERTIFICATE_JOBS_QUEUE) private readonly certificateQueue: Queue,
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
    return this.performDeletion(userId, input, {
      actorUserId: userId,
      initiatedBy: 'self',
    });
  }

  /**
   * Deletes SOMEBODY ELSE'S account, on a Platform Owner's authority.
   *
   * ONE IMPLEMENTATION, TWO DOORS. This runs the identical sequence as
   * self-deletion — same archival, same membership removal, same
   * anonymisation, same revocation — because a person's data must not end
   * up in a different state depending on who pressed the button. A second
   * deletion path would be a second thing to keep correct, and the one
   * that fell behind would be the one used least and reviewed least.
   *
   * WHY THE TARGET'S OWN CONTEXT. Every write below runs under the
   * TARGET's `runInUserContext`, never the operator's. The self-membership
   * DELETE policies are scoped to `user_id = app.current_user_id`, so
   * acting as the target is what lets RLS agree with the guard rather
   * than needing a new, broader policy written specially for operators.
   * This is the same "resolve the target, delegate into existing scoped
   * logic" shape `PlatformUsersService` already uses for reads.
   *
   * TWO REFUSALS, BOTH ON THE SERVER. A Platform Owner may not delete
   * themselves through this door, and may not delete another Platform
   * Owner. Nothing in the product can grant `is_platform_owner` back — only
   * a provisioning script with database access can — so an operator
   * deleting the last administrator would lock the platform out of its own
   * administration with no way back through the UI. The authorization to
   * be here at all is `PlatformOwnerGuard`'s job; it is re-checked here
   * anyway, because this is the most destructive call in the product and a
   * controller decorator is one edit away from being removed.
   */
  async deleteUserAsPlatformOwner(
    actorUserId: string,
    targetUserId: string,
    input: DeleteAccountInput,
  ): Promise<DeleteAccountResult> {
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
        messageKey: 'errors.auth.platformOwnerCannotSelfDelete',
      });
    }

    return this.performDeletion(targetUserId, input, {
      actorUserId,
      initiatedBy: 'platform_owner',
    });
  }

  /**
   * The deletion itself. Reached only through the two entry points above,
   * which decide WHO may ask; this decides WHAT happens, identically for
   * both.
   */
  private async performDeletion(
    userId: string,
    input: DeleteAccountInput,
    actor: DeletionActor,
  ): Promise<DeleteAccountResult> {
    const user = await this.tenancyContextService.runInUserContext(userId, (tx) =>
      tx.user.findUnique({
        where: { id: userId },
        select: { id: true, isPlatformOwner: true, status: true },
      }),
    );

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
    // P64 Phase 3 (§D.6): certificates keep their issuance facts but lose the
    // holder's name; done on the certificate queue so this module never
    // imports the certificates module (which imports identity).
    await this.enqueueCertificateAnonymisation(userId);

    const sessionIds = await this.anonymiseAndRevoke(userId, input, actor);

    // Revocation is written to the denylist AFTER the transaction commits:
    // the database state is already authoritative, and a Redis failure
    // here must not roll back a completed deletion. `isRevoked`'s own
    // database fallback still refuses these sessions if Redis is down.
    for (const sessionId of sessionIds) {
      await this.sessionRevocationService.markRevoked(sessionId);
    }

    this.logger.log(
      {
        userId,
        initiatedBy: actor.initiatedBy,
        academiesArchived,
        sessionsRevoked: sessionIds.length,
      },
      'Account deleted.',
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
  private async enqueueCertificateAnonymisation(userId: string): Promise<void> {
    const payload: CertificateAnonymizeJobPayload = { userId };
    try {
      await this.certificateQueue.add(CERTIFICATE_ANONYMIZE_JOB, payload, {
        // No colon: BullMQ refuses two-segment custom ids containing `:` (see `quizDeadlineJobId`).
        jobId: `certificate-anonymize-${userId}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: { count: 1_000 },
      });
    } catch (error) {
      this.logger.error(
        { userId, error: error instanceof Error ? error.message : String(error) },
        'Could not enqueue certificate anonymisation; retry from the platform tooling.',
      );
    }
  }

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
    actor: DeletionActor,
  ): Promise<string[]> {
    // The deleted account's OWN context: every per-user table below is
    // row-level secured to its owner, and a context-free statement would
    // silently match nothing.
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
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
      // Google Identity — the external identity dies with the account, so the
      // same Google account can later start a fresh Atlas account (the
      // anonymised row survives, so the FK cascade never fires on its own).
      await tx.userAuthIdentity.deleteMany({ where: { userId } });
      await tx.twoFactorRecoveryCode.deleteMany({ where: { userId } });
      await tx.passwordResetToken.deleteMany({ where: { userId } });
      await tx.emailVerificationToken.deleteMany({ where: { userId } });
      // Authentication audit — nothing that could still vouch for this
      // person outlives the account: remembered browsers are revoked, open
      // sign-in codes and pending Google flows (a settings link) are closed,
      // and deletion codes are removed.
      await tx.trustedDevice.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.authEmailChallenge.updateMany({
        where: { userId, consumedAt: null },
        data: { consumedAt: now },
      });
      await tx.authOAuthFlow.updateMany({
        where: { linkUserId: userId, completedAt: null },
        data: { completedAt: now },
      });
      await tx.accountDeletionChallenge.deleteMany({ where: { userId } });

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
        // The operator when an operator did it, the subject when they did
        // it themselves — never flattened to the subject, or the trail
        // would lose who actually authorised it.
        actorUserId: actor.actorUserId,
        action:
          actor.initiatedBy === 'platform_owner'
            ? 'account.deleted_by_platform_owner'
            : 'account.deleted',
        targetType: 'user',
        targetId: userId,
        context: {
          initiatedBy: actor.initiatedBy,
          reason: input.reason ?? 'not_given',
          hasFeedback: Boolean(input.feedback),
          sessionsRevoked: liveSessions.length,
        },
      });

      return liveSessions.map((session) => session.sessionId);
    });
  }
}
