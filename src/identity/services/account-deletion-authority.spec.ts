/**
 * Who may delete whom, and what the audit trail says afterwards.
 *
 * These are the checks that stop the administrative deletion door from
 * being a privilege-escalation or lockout tool, so they are pinned at the
 * SERVICE, not at the controller. `PlatformOwnerGuard` is the first
 * barrier and a good one, but it is a decorator: one careless edit
 * removes it, and nothing else in the request would notice. The service
 * re-checking the same fact is what makes that edit survivable.
 *
 * The lockout refusal matters more than it looks. Nothing in Atlas can
 * grant `is_platform_owner` — not an endpoint, not the UI, only a
 * provisioning script with database access. An operator who deleted the
 * last Platform Owner would lock the platform out of its own
 * administration with no way back through the product, so "delete another
 * Platform Owner" is refused rather than merely discouraged.
 *
 * What is NOT covered here: RLS. Every write runs through fake
 * transactions, which return whatever they are told to. Whether the
 * target's own context actually lets the membership deletes through is a
 * property of SQL policies and belongs in a real-Postgres e2e.
 */
import { ForbiddenException } from '@nestjs/common';
import { AccountDeletionService } from './account-deletion.service';
import type { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import type { SessionRevocationService } from './session-revocation.service';
import type { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';

interface AuditRow {
  actorUserId: string;
  action: string;
  targetId: string;
  context?: Record<string, unknown>;
}

/** Users the fake database knows about, keyed by id. */
function build(users: Record<string, { isPlatformOwner?: boolean; status?: string }>) {
  const audits: AuditRow[] = [];
  const revoked: string[] = [];
  const enqueued: unknown[] = [];

  const tx = {
    organization: { findMany: async () => [] },
    academy: { updateMany: async () => ({ count: 0 }) },
    organizationMembership: { findMany: async () => [], deleteMany: async () => ({}) },
    academyMember: { deleteMany: async () => ({}) },
    academyStudent: { deleteMany: async () => ({}), count: async () => 0 },
    courseInstructor: { deleteMany: async () => ({}) },
    refreshToken: {
      findMany: async () => [{ sessionId: 's1' }],
      updateMany: async () => ({ count: 1 }),
    },
    userTwoFactor: { deleteMany: async () => ({}) },
    userAuthIdentity: { deleteMany: async () => ({}) },
    userCredential: { deleteMany: async () => ({}) },
    twoFactorRecoveryCode: { deleteMany: async () => ({}) },
    passwordResetToken: { deleteMany: async () => ({}) },
    emailVerificationToken: { deleteMany: async () => ({}) },
    trustedDevice: { updateMany: async () => ({}) },
    authEmailChallenge: { updateMany: async () => ({}) },
    authOAuthFlow: { updateMany: async () => ({}) },
    accountDeletionChallenge: { deleteMany: async () => ({}) },
    user: {
      update: async () => ({}),
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = users[where.id];
        return row
          ? {
              id: where.id,
              isPlatformOwner: row.isPlatformOwner ?? false,
              status: row.status ?? 'active',
            }
          : null;
      },
    },
  };

  const tenancy = {
    runInUserContext: async (_i: string, w: (t: unknown) => unknown) => w(tx),
    runInTenantContext: async (_i: string, w: (t: unknown) => unknown) => w(tx),
    runInTenantAndUserContext: async (
      _o: string,
      _u: string,
      w: (t: unknown) => unknown,
    ) => w(tx),
  } as unknown as TenancyContextService;

  const service = new AccountDeletionService(
    { add: async (...a: unknown[]) => enqueued.push(a) } as never,
    tenancy,
    {
      markRevoked: async (s: string) => revoked.push(s),
    } as unknown as SessionRevocationService,
    {
      writeBestEffort: async (_t: unknown, row: AuditRow) => audits.push(row),
    } as unknown as AuditLogWriterService,
  );

  return { service, audits, revoked };
}

describe('AccountDeletionService — who may delete whom', () => {
  describe('the administrative door', () => {
    it('refuses an actor who is not a platform owner, even past the guard', async () => {
      const { service } = build({
        impostor: { isPlatformOwner: false },
        victim: {},
      });
      await expect(
        service.deleteUserAsPlatformOwner('impostor', 'victim', {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses an actor the database has never heard of', async () => {
      const { service } = build({ victim: {} });
      await expect(
        service.deleteUserAsPlatformOwner('ghost', 'victim', {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a platform owner deleting themselves through it', async () => {
      const { service } = build({ owner: { isPlatformOwner: true } });
      await expect(
        service.deleteUserAsPlatformOwner('owner', 'owner', {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses deleting ANOTHER platform owner, because nothing can grant the flag back', async () => {
      const { service } = build({
        owner: { isPlatformOwner: true },
        otherOwner: { isPlatformOwner: true },
      });
      await expect(
        service.deleteUserAsPlatformOwner('owner', 'otherOwner', {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('deletes an ordinary user and records the OPERATOR as the actor', async () => {
      const { service, audits, revoked } = build({
        owner: { isPlatformOwner: true },
        learner: {},
      });

      const result = await service.deleteUserAsPlatformOwner('owner', 'learner', {
        reason: 'privacy_concerns',
      });

      expect(result.deleted).toBe(true);
      expect(revoked).toContain('s1');

      const row = audits.at(-1);
      // The operator authorised it; the learner is what it happened to.
      expect(row?.actorUserId).toBe('owner');
      expect(row?.targetId).toBe('learner');
      // A distinct action, so "they left" and "we removed them" never
      // aggregate into the same number.
      expect(row?.action).toBe('account.deleted_by_platform_owner');
      expect(row?.context?.initiatedBy).toBe('platform_owner');
    });
  });

  describe('the self-service door', () => {
    it('still refuses a platform owner deleting themselves', async () => {
      const { service } = build({ owner: { isPlatformOwner: true } });
      await expect(service.deleteOwnAccount('owner', {})).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('records the subject as their own actor', async () => {
      const { service, audits } = build({ learner: {} });
      await service.deleteOwnAccount('learner', {});

      const row = audits.at(-1);
      expect(row?.actorUserId).toBe('learner');
      expect(row?.action).toBe('account.deleted');
      expect(row?.context?.initiatedBy).toBe('self');
    });

    it('is idempotent — deleting an already-deleted account is not an error', async () => {
      const { service, audits } = build({ gone: { status: 'deleted' } });
      await expect(service.deleteOwnAccount('gone', {})).resolves.toEqual({
        deleted: true,
        academiesArchived: 0,
      });
      // A no-op must not write a second deletion into the audit trail.
      expect(audits).toHaveLength(0);
    });
  });
});
