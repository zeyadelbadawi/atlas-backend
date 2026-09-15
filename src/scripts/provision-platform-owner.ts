/**
 * Provision (or re-activate) ONE Platform Owner account — for QA/ops.
 *
 * LEGITIMATE, NOT A BYPASS. It creates a normal user row exactly as
 * `prisma/seed.ts` does: a real Argon2id hash from the production
 * `PasswordHasherService`, `isPlatformOwner: true`, `status: 'active'`.
 * Nothing about authentication or authorization is weakened — the account
 * then satisfies `PlatformOwnerGuard` through the ordinary path.
 *
 * SECRETS COME FROM THE ENVIRONMENT, NEVER FROM SOURCE:
 *   PLATFORM_OWNER_EMAIL     — the account email
 *   PLATFORM_OWNER_PASSWORD  — the fresh password (hashed, never stored raw)
 * The password is read, hashed, and discarded; it is never logged, printed,
 * or written anywhere in plaintext.
 *
 * SAFE ON A REAL DATABASE:
 *   - Refuses to run without both env vars.
 *   - If the email already exists AND is NOT already a platform owner, it
 *     STOPS and reports, rather than overwriting an existing human account.
 *     (Re-running for the same platform-owner test account just rotates the
 *     password — idempotent.)
 *   - Touches only this one row; never deletes or edits anyone else.
 *
 * Run (on the host that can reach the target DB), e.g. on the VPS:
 *   PLATFORM_OWNER_EMAIL=... PLATFORM_OWNER_PASSWORD=... \
 *     node dist/scripts/provision-platform-owner.js
 * or in dev via ts-node. It prints only a non-secret confirmation.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../database/prisma.service';
import { PasswordHasherService } from '../identity/services/password-hasher.service';

async function main(): Promise<void> {
  const email = process.env.PLATFORM_OWNER_EMAIL?.trim().toLowerCase();
  const password = process.env.PLATFORM_OWNER_PASSWORD;
  if (!email || !password) {
    console.error(
      'Refusing to run: set PLATFORM_OWNER_EMAIL and PLATFORM_OWNER_PASSWORD.',
    );
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    const hasher = app.get(PasswordHasherService);

    const existing = await prisma.user.findUnique({
      where: { email },
      select: { id: true, isPlatformOwner: true, status: true },
    });

    if (existing && !existing.isPlatformOwner) {
      // Never silently take over an existing non-owner human account.
      console.error(
        `STOP: a user with this email already exists and is NOT a platform owner. ` +
          `Not modifying it. (id ${existing.id}, status ${existing.status})`,
      );
      process.exit(2);
    }

    const passwordHash = await hasher.hash(password);

    const user = await prisma.user.upsert({
      where: { email },
      create: {
        email,
        name: 'Platform QA Owner',
        passwordHash,
        isPlatformOwner: true,
        status: 'active',
      },
      // For an existing platform-owner test account: rotate the password,
      // ensure the flag and active status. No other fields touched.
      update: { passwordHash, isPlatformOwner: true, status: 'active' },
      select: { id: true, isPlatformOwner: true, status: true },
    });

    // Non-secret confirmation only — never the password or the hash.
    console.log(
      JSON.stringify({
        provisioned: true,
        created: !existing,
        userId: user.id,
        isPlatformOwner: user.isPlatformOwner,
        status: user.status,
      }),
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('Provisioning failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
