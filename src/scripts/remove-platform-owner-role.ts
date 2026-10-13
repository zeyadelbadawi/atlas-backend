/* eslint-disable no-console -- an operator CLI: the plan on stdout is its interface. */
/**
 * Remove the Platform Owner role from one or more UNSECURED accounts
 * (B0-OC-01) — an operator action on the owner connection. DRY RUN BY
 * DEFAULT: without the two apply variables it only prints the plan.
 *
 * LEGITIMATE, NOT A BYPASS. The product deliberately cannot take the role
 * away (the application role has no UPDATE on `is_platform_owner`), just
 * as it cannot grant it: `provision-platform-owner.ts` grants on this same
 * connection. All rules live in `platform-owner-role-removal.ts` and are
 * re-checked inside the transaction: the operator must be an active
 * Platform Owner with a confirmed authenticator; never the operator's own
 * account; never a target with a confirmed authenticator; never leaving
 * zero secured Platform Owners. One audit row per target; the targets'
 * sessions end. No row is deleted — the account stays an ordinary user,
 * which Platform → Users can then delete like any other.
 *
 * NO APPLICATION CONTEXT. Unlike the older operator scripts, this one does
 * not boot `AppModule`: booting it starts the app's schedulers and queue
 * workers inside a short-lived CLI process. It needs only the owner
 * connection and, for the access-token denylist, Redis.
 *
 * IDS ONLY, NEVER EMAILS — see `delete-user.ts` for why.
 *
 * BEFORE APPLYING (runbook `docs/PLATFORM_OWNER_ROLE_REMOVAL_RUNBOOK.md`):
 * the owner has approved the exact ids in writing, a verified backup exists,
 * and the dry run's output has been read.
 *
 * Run inside the backend container (DATABASE_URL = owner connection):
 *   ROLE_REMOVAL_ACTOR_ID=<secured platform owner uuid> \
 *   ROLE_REMOVAL_USER_IDS=<uuid>,<uuid> \
 *   ROLE_REMOVAL_REASON="<ticket or short reason>" \
 *     node dist/scripts/remove-platform-owner-role.js          # dry run
 * then, to apply, add both:
 *   ROLE_REMOVAL_APPLY=yes ROLE_REMOVAL_CONFIRM=remove-platform-owner-role:<count>
 *
 * Prints only non-secret facts (masked emails, counts, ids).
 */
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { SESSION_REVOKED_KEY_PREFIX } from '../identity/services/session-revocation.service';
import {
  applyRoleRemoval,
  planRoleRemoval,
  RoleRemovalRefusedError,
} from '../identity/services/platform-owner-role-removal';

async function denylist(sessionIds: readonly string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  const url = process.env.REDIS_URL;
  if (!url) {
    console.warn('REDIS_URL unset: sessions are revoked in the database only.');
    return;
  }
  const ttl = Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900);
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    for (const sessionId of sessionIds) {
      await redis.set(`${SESSION_REVOKED_KEY_PREFIX}${sessionId}`, '1', 'EX', ttl);
    }
  } catch (error) {
    // The database revocation already committed and the guard falls back
    // to it; Platform access ended with the role.
    console.warn(
      JSON.stringify({
        redisDenylist: 'failed',
        error: error instanceof Error ? error.message : 'unknown error',
      }),
    );
  } finally {
    redis.disconnect();
  }
}

async function main(): Promise<void> {
  const actorId = process.env.ROLE_REMOVAL_ACTOR_ID?.trim() ?? '';
  const targetIds = (process.env.ROLE_REMOVAL_USER_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const reason = process.env.ROLE_REMOVAL_REASON?.trim() ?? '';
  const apply = process.env.ROLE_REMOVAL_APPLY === 'yes';
  const confirm = process.env.ROLE_REMOVAL_CONFIRM?.trim();
  const ownerUrl = process.env.DATABASE_URL;

  if (!actorId || targetIds.length === 0 || !reason) {
    console.error(
      'Refusing to run: set ROLE_REMOVAL_ACTOR_ID, ROLE_REMOVAL_USER_IDS (uuids, never emails) and ROLE_REMOVAL_REASON.',
    );
    process.exit(1);
  }
  if (!ownerUrl) {
    console.error(
      'DATABASE_URL (the owner connection) is required for this operator action.',
    );
    process.exit(1);
  }

  const prisma = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
  try {
    const plan = await planRoleRemoval(prisma, { actorId, targetIds });
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', plan }, null, 2));

    if (plan.refusals.length > 0) {
      console.error(JSON.stringify({ refused: plan.refusals.map((r) => r.code) }));
      process.exitCode = 2;
      return;
    }
    if (!apply) {
      console.log('DRY RUN: nothing was changed.');
      return;
    }
    const expected = `remove-platform-owner-role:${plan.targets.length}`;
    if (confirm !== expected) {
      console.error(
        `Refusing to apply: set ROLE_REMOVAL_CONFIRM=${expected} to confirm.`,
      );
      process.exitCode = 2;
      return;
    }

    const result = await applyRoleRemoval(
      prisma,
      { actorId, targetIds, reason },
      { denylistSessions: denylist },
    );
    console.log(JSON.stringify({ applied: true, ...result }));
  } catch (error) {
    if (error instanceof RoleRemovalRefusedError) {
      console.error(JSON.stringify({ refused: error.plan.refusals.map((r) => r.code) }));
      process.exitCode = 2;
      return;
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  // Message only: a stack or a Prisma error can carry connection strings.
  console.error(
    JSON.stringify({ failed: error instanceof Error ? error.message : 'unknown error' }),
  );
  process.exit(1);
});
