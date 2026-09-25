/**
 * Delete ONE account by primary key, on a Platform Owner's authority — for
 * ops, when no browser session is available.
 *
 * LEGITIMATE, NOT A BYPASS. It calls
 * `AccountDeletionService.deleteUserAsPlatformOwner`, the exact same method
 * `POST /platform-user-management/:userId/delete` calls. Every rule still
 * applies: the operator must really be a platform owner, a platform owner
 * cannot be deleted through it, the work runs in the target's own RLS
 * context, and the audit row records the operator as actor. Nothing about
 * authorization is weakened and no SQL is written by hand — a hand-rolled
 * `DELETE` here would be a second deletion implementation, and the one used
 * least is the one that drifts.
 *
 * IDS ONLY, NEVER EMAILS. The target is a primary key, because "delete
 * everything matching this email" is how the wrong person gets deleted:
 * addresses are ambiguous under Gmail dot-folding, case, and plus-tags. The
 * caller must have resolved the exact row first, and this prints who it
 * resolved before acting so the operator log shows exactly whose account
 * went.
 *
 * SAFE ON A REAL DATABASE:
 *   - Refuses without both ids.
 *   - Refuses if either id does not exist, rather than silently doing nothing.
 *   - Reports the target's email and role BEFORE deleting, so a mistake is
 *     visible in the log even after the fact.
 *   - Idempotent: an already-deleted account reports success and changes
 *     nothing, exactly as the API does.
 *
 * Run inside the backend container:
 *   DELETE_ACTOR_ID=<platform owner uuid> DELETE_USER_ID=<target uuid> \
 *     node dist/scripts/delete-user.js
 *
 * It prints only non-secret facts.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../database/prisma.service';
import { AccountDeletionService } from '../identity/services/account-deletion.service';
import type { AccountDeletionReason } from '../identity/services/account-deletion.service';

async function main(): Promise<void> {
  const actorId = process.env.DELETE_ACTOR_ID?.trim();
  const targetId = process.env.DELETE_USER_ID?.trim();
  const reason = process.env.DELETE_REASON?.trim() as AccountDeletionReason | undefined;

  if (!actorId || !targetId) {
    console.error(
      'Refusing to run: set DELETE_ACTOR_ID and DELETE_USER_ID (uuids, never emails).',
    );
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const prisma = app.get(PrismaService);
    const deletion = app.get(AccountDeletionService);

    // Resolve BOTH before acting, and say so. An operator reading this log
    // afterwards must be able to see which account was actually targeted,
    // not just the uuid they typed.
    const [actor, target] = await Promise.all([
      prisma.user.findUnique({
        where: { id: actorId },
        select: { id: true, email: true, isPlatformOwner: true },
      }),
      prisma.user.findUnique({
        where: { id: targetId },
        select: { id: true, email: true, isPlatformOwner: true, status: true },
      }),
    ]);

    if (!actor) {
      console.error(JSON.stringify({ refused: 'actor_not_found', actorId }));
      process.exit(1);
    }
    if (!target) {
      console.error(JSON.stringify({ refused: 'target_not_found', targetId }));
      process.exit(1);
    }

    console.log(
      JSON.stringify({
        about_to_delete: {
          id: target.id,
          email: target.email,
          isPlatformOwner: target.isPlatformOwner,
          status: target.status,
        },
        on_authority_of: { id: actor.id, email: actor.email },
      }),
    );

    // The canonical path. Its own refusals — actor is not a platform owner,
    // target is a platform owner, actor is the target — are enforced inside.
    const result = await deletion.deleteUserAsPlatformOwner(actorId, targetId, {
      ...(reason ? { reason } : {}),
    });

    console.log(JSON.stringify({ ...result, targetId }));
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  // Message only. A stack or a thrown Prisma error can carry connection
  // strings, and this runs where logs are kept.
  console.error(
    JSON.stringify({
      failed: error instanceof Error ? error.message : 'unknown error',
    }),
  );
  process.exit(1);
});
