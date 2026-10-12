/**
 * Break-glass second-factor reset for ONE account, on a Platform Owner's
 * authority (B0-OC-03, runbook R3) — for someone who has lost BOTH their
 * authenticator and their recovery codes.
 *
 * LEGITIMATE, NOT A BYPASS. It calls `TwoFactorService.resetByOperator`,
 * which enforces every rule: the operator must really be a Platform Owner
 * and cannot reset themselves; only the target's own second-factor rows
 * are removed, in the target's own RLS context; every session of the
 * target ends; the audit row (`auth.two_factor.reset_by_operator`) names
 * the operator, the target and the reason; the target is emailed. Nothing
 * about authentication is switched off: the next sign-in still needs the
 * password, and a Platform Owner must re-enrol before any platform page
 * opens. No SQL is written by hand.
 *
 * BEFORE RUNNING (runbook R3): the requester's identity is confirmed out of
 * band by a second person over a channel already on file, and the reset is
 * approved in writing by someone other than the requester.
 *
 * IDS ONLY, NEVER EMAILS — see `delete-user.ts` for why.
 *
 * Run inside the backend container:
 *   RESET_ACTOR_ID=<platform owner uuid> RESET_USER_ID=<target uuid> \
 *   RESET_REASON="<ticket or short reason>" \
 *     node dist/scripts/reset-two-factor.js
 *
 * It prints only non-secret facts.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../database/prisma.service';
import { runInUserContext } from '../database/user-context';
import { TwoFactorService } from '../identity/services/two-factor.service';

async function main(): Promise<void> {
  const actorId = process.env.RESET_ACTOR_ID?.trim();
  const targetId = process.env.RESET_USER_ID?.trim();
  const reason = process.env.RESET_REASON?.trim();

  if (!actorId || !targetId || !reason) {
    console.error(
      'Refusing to run: set RESET_ACTOR_ID, RESET_USER_ID (uuids, never emails) and RESET_REASON.',
    );
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const prisma = app.get(PrismaService);
    const twoFactor = app.get(TwoFactorService);

    // Say whose factor is about to go before acting, so the operator log
    // shows the account that was actually targeted, not just a uuid.
    const target = await runInUserContext(prisma, targetId, (tx) =>
      tx.user.findUnique({
        where: { id: targetId },
        select: { id: true, email: true, isPlatformOwner: true, status: true },
      }),
    );
    if (!target) {
      console.error(JSON.stringify({ refused: 'target_not_found', targetId }));
      process.exit(1);
    }
    console.log(
      JSON.stringify({
        about_to_reset_two_factor: target,
        on_authority_of: actorId,
      }),
    );

    // The service enforces the actor rules (Platform Owner, not self).
    const result = await twoFactor.resetByOperator(actorId, targetId, reason);
    console.log(JSON.stringify({ ...result, targetId }));
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  // Message only: a stack or a Prisma error can carry connection strings.
  console.error(
    JSON.stringify({
      failed: error instanceof Error ? error.message : 'unknown error',
    }),
  );
  process.exit(1);
});
