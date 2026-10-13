/**
 * Removing the Platform Owner role from an account (B0-OC-01) — the plan
 * and the change, as plain functions so the operator script and the e2e
 * spec run exactly the same code.
 *
 * WHY THIS EXISTS. Nothing in the product can take `is_platform_owner`
 * away: the application role has no UPDATE privilege on the column, and
 * `AccountDeletionService` / account suspension refuse a Platform Owner on
 * purpose. Retiring an unused Platform Owner account (one that never set
 * up an authenticator) therefore needs an operator step on the owner
 * connection — the same connection `provision-platform-owner.ts` uses to
 * grant the role. After the role is gone the account is an ordinary user
 * and can be deleted through Platform → Users like any other.
 *
 * WHAT IT REFUSES (every refusal is reported in the plan; `apply` re-checks
 * all of them inside the transaction, with the Platform Owner rows locked):
 *   - an operator who is not an active Platform Owner WITH a confirmed
 *     authenticator — the person removing others must themselves be secured;
 *   - the operator's own account;
 *   - a target that is not a Platform Owner, or does not exist;
 *   - a target WITH a confirmed authenticator — this tool retires unused,
 *     unsecured accounts, never a secured one by mistake;
 *   - any change that would leave no active Platform Owner with a confirmed
 *     authenticator.
 *
 * WHAT IT CHANGES (apply only), in one transaction: `is_platform_owner =
 * false` on the targets, one audit row per target
 * (`platform_owner.role_removed_by_operator`, actor = the operator), and
 * every refresh session of each target revoked; then, after commit, the
 * sessions' access tokens are denylisted in Redis.
 * Nothing else: no row is deleted, the account, its organizations and its
 * history stay exactly as they are.
 *
 * PRINTS NO SECRET. Emails are masked; no hash, token or code is selected.
 */
import { Prisma, PrismaClient } from '@prisma/client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** At least this many secured Platform Owners must remain afterwards. */
export const MIN_SECURED_PLATFORM_OWNERS = 1;

export type RoleRemovalRefusal =
  | 'no_targets'
  | 'invalid_id'
  | 'duplicate_target'
  | 'actor_not_found'
  | 'actor_not_platform_owner'
  | 'actor_not_active'
  | 'actor_without_confirmed_totp'
  | 'target_is_actor'
  | 'target_not_found'
  | 'target_not_platform_owner'
  | 'target_has_confirmed_totp'
  | 'would_leave_no_secured_platform_owner';

export interface OwnedOrganizationFacts {
  readonly id: string;
  readonly status: string;
  readonly academies: number;
  readonly members: number;
  readonly subscription: string;
}

export interface RoleRemovalTargetFacts {
  readonly id: string;
  readonly email: string;
  readonly status: string;
  readonly deleted: boolean;
  readonly isPlatformOwner: boolean;
  readonly totp: 'confirmed' | 'pending' | 'none';
  readonly liveSessions: number;
  readonly auditRowsAsActor: number;
  readonly organizationMemberships: number;
  readonly academyMemberships: number;
  readonly ownedOrganizations: readonly OwnedOrganizationFacts[];
}

export interface RoleRemovalPlan {
  readonly actorId: string;
  readonly targets: readonly RoleRemovalTargetFacts[];
  readonly securedPlatformOwnersBefore: number;
  readonly securedPlatformOwnersAfter: number;
  readonly refusals: readonly {
    readonly code: RoleRemovalRefusal;
    readonly id?: string;
  }[];
}

type Db = PrismaClient | Prisma.TransactionClient;

/** First two characters of the local part, its length, and the domain. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  return `${local.slice(0, 2)}…(${local.length})@${email.slice(at + 1)}`;
}

async function securedPlatformOwnerIds(db: Db): Promise<string[]> {
  const rows = await db.user.findMany({
    where: {
      isPlatformOwner: true,
      status: 'active',
      deletedAt: null,
      twoFactor: { confirmedAt: { not: null } },
    },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

async function targetFacts(db: Db, id: string): Promise<RoleRemovalTargetFacts | null> {
  const user = await db.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      status: true,
      deletedAt: true,
      isPlatformOwner: true,
      twoFactor: { select: { confirmedAt: true } },
    },
  });
  if (!user) return null;
  const now = new Date();
  const [
    liveSessions,
    auditRowsAsActor,
    organizationMemberships,
    academyMemberships,
    orgs,
  ] = await Promise.all([
    db.refreshToken.count({
      where: { userId: id, revokedAt: null, expiresAt: { gt: now } },
    }),
    db.auditLogEntry.count({ where: { actorUserId: id } }),
    db.organizationMembership.count({ where: { userId: id } }),
    db.academyMember.count({ where: { userId: id } }),
    db.organization.findMany({
      where: { ownerUserId: id },
      select: {
        id: true,
        status: true,
        _count: { select: { academies: true, memberships: true } },
        subscription: { select: { status: true } },
      },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  return {
    id: user.id,
    email: maskEmail(user.email),
    status: user.status,
    deleted: user.deletedAt !== null,
    isPlatformOwner: user.isPlatformOwner,
    totp: user.twoFactor?.confirmedAt ? 'confirmed' : user.twoFactor ? 'pending' : 'none',
    liveSessions,
    auditRowsAsActor,
    organizationMemberships,
    academyMemberships,
    ownedOrganizations: orgs.map((org) => ({
      id: org.id,
      status: org.status,
      academies: org._count.academies,
      members: org._count.memberships,
      subscription: org.subscription?.status ?? 'none',
    })),
  };
}

/** Read-only: what removing the role would do, and every reason it would be refused. */
export async function planRoleRemoval(
  db: Db,
  input: { readonly actorId: string; readonly targetIds: readonly string[] },
): Promise<RoleRemovalPlan> {
  const refusals: { code: RoleRemovalRefusal; id?: string }[] = [];
  const actorId = input.actorId.trim();
  const targetIds = input.targetIds.map((id) => id.trim()).filter(Boolean);

  if (targetIds.length === 0) refusals.push({ code: 'no_targets' });
  for (const id of [actorId, ...targetIds]) {
    if (!UUID.test(id)) refusals.push({ code: 'invalid_id', id });
  }
  if (new Set(targetIds).size !== targetIds.length)
    refusals.push({ code: 'duplicate_target' });
  if (refusals.some((r) => r.code === 'invalid_id')) {
    return {
      actorId,
      targets: [],
      securedPlatformOwnersBefore: 0,
      securedPlatformOwnersAfter: 0,
      refusals,
    };
  }

  const actor = await db.user.findUnique({
    where: { id: actorId },
    select: {
      isPlatformOwner: true,
      status: true,
      deletedAt: true,
      twoFactor: { select: { confirmedAt: true } },
    },
  });
  if (!actor) refusals.push({ code: 'actor_not_found', id: actorId });
  else {
    if (!actor.isPlatformOwner)
      refusals.push({ code: 'actor_not_platform_owner', id: actorId });
    if (actor.status !== 'active' || actor.deletedAt) {
      refusals.push({ code: 'actor_not_active', id: actorId });
    }
    if (!actor.twoFactor?.confirmedAt) {
      refusals.push({ code: 'actor_without_confirmed_totp', id: actorId });
    }
  }

  const targets: RoleRemovalTargetFacts[] = [];
  for (const id of new Set(targetIds)) {
    if (id === actorId) {
      refusals.push({ code: 'target_is_actor', id });
      continue;
    }
    const facts = await targetFacts(db, id);
    if (!facts) {
      refusals.push({ code: 'target_not_found', id });
      continue;
    }
    targets.push(facts);
    if (!facts.isPlatformOwner) refusals.push({ code: 'target_not_platform_owner', id });
    if (facts.totp === 'confirmed')
      refusals.push({ code: 'target_has_confirmed_totp', id });
  }

  const secured = await securedPlatformOwnerIds(db);
  const remaining = secured.filter((id) => !targetIds.includes(id));
  if (remaining.length < MIN_SECURED_PLATFORM_OWNERS) {
    refusals.push({ code: 'would_leave_no_secured_platform_owner' });
  }

  return {
    actorId,
    targets,
    securedPlatformOwnersBefore: secured.length,
    securedPlatformOwnersAfter: remaining.length,
    refusals,
  };
}

export const ROLE_REMOVED_AUDIT_ACTION = 'platform_owner.role_removed_by_operator';

export interface RoleRemovalDeps {
  /**
   * Closes the access-token window for the revoked sessions (the Redis
   * denylist `SessionRevocationService` reads). Best-effort and after
   * commit: the database revocation is the durable record, the guard falls
   * back to it, and Platform access already ended with the role.
   */
  readonly denylistSessions: (sessionIds: readonly string[]) => Promise<void>;
}

export class RoleRemovalRefusedError extends Error {
  constructor(readonly plan: RoleRemovalPlan) {
    super(`refused: ${plan.refusals.map((r) => r.code).join(', ')}`);
  }
}

export interface RoleRemovalResult {
  readonly removed: readonly string[];
  readonly sessionsRevoked: Readonly<Record<string, number>>;
}

/**
 * Removes the role. Re-plans inside one transaction with every Platform
 * Owner row locked (`FOR UPDATE`), so a check made at dry-run time can't
 * go stale before the write, and refuses with nothing changed if any check
 * fails. In the same transaction: the flag, one audit row per target, and
 * the targets' refresh sessions revoked. The Redis denylist follows commit.
 *
 * Runs on a bare PrismaClient (no application context), so an operator
 * run never starts the app's background workers.
 */
export async function applyRoleRemoval(
  db: PrismaClient,
  input: {
    readonly actorId: string;
    readonly targetIds: readonly string[];
    readonly reason: string;
  },
  deps: RoleRemovalDeps,
): Promise<RoleRemovalResult> {
  const reason = input.reason.trim().slice(0, 500);
  if (!reason) throw new Error('refused: a reason is required');

  const { plan, sessionIds } = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE is_platform_owner FOR UPDATE`;
    const fresh = await planRoleRemoval(tx, input);
    if (fresh.refusals.length > 0) throw new RoleRemovalRefusedError(fresh);
    const ids = fresh.targets.map((t) => t.id);
    const updated = await tx.user.updateMany({
      where: { id: { in: ids }, isPlatformOwner: true },
      data: { isPlatformOwner: false },
    });
    if (updated.count !== ids.length) {
      throw new Error(`refused: expected ${ids.length} rows, updated ${updated.count}`);
    }
    const revoked: Record<string, string[]> = {};
    for (const target of fresh.targets) {
      const rows = await tx.$queryRaw<{ session_id: string }[]>`
        UPDATE "refresh_tokens" SET "revoked_at" = NOW()
        WHERE "user_id" = ${target.id} AND "revoked_at" IS NULL
        RETURNING "session_id"`;
      revoked[target.id] = [...new Set(rows.map((row) => row.session_id))];
      await tx.auditLogEntry.create({
        data: {
          actorUserId: fresh.actorId,
          action: ROLE_REMOVED_AUDIT_ACTION,
          targetType: 'user',
          targetId: target.id,
          context: {
            reason,
            hadConfirmedAuthenticator: target.totp === 'confirmed',
            ownedOrganizations: target.ownedOrganizations.length,
          },
        },
      });
    }
    return { plan: fresh, sessionIds: revoked };
  });

  await deps.denylistSessions(Object.values(sessionIds).flat());
  return {
    removed: plan.targets.map((t) => t.id),
    sessionsRevoked: Object.fromEntries(
      Object.entries(sessionIds).map(([id, sessions]) => [id, sessions.length]),
    ),
  };
}
