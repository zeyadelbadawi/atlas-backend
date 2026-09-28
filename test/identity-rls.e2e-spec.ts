/**
 * Authentication audit, Decision 2 — row-level security on the identity
 * tables, proved DIRECTLY against Postgres as the application role.
 *
 * Going through the services would not prove anything: every service adds
 * its own `user_id` predicate and would pass with or without RLS. So each
 * case opens the same context the application opens (`TenancyContextService`
 * on the app's own `atlas_app` connection) and issues raw SQL at ANOTHER
 * account's rows — the only way to observe what the database itself
 * enforces.
 *
 *   IDRLS-01  the app role is NOSUPERUSER NOBYPASSRLS, owns none of the
 *             tables, and every identity table has ENABLE + FORCE RLS
 *   IDRLS-02  with no context, not one row of any identity table is visible
 *   IDRLS-03  credential tables: an account sees only its own rows; another
 *             account's are invisible, un-updatable, un-deletable, and no row
 *             can be written for it
 *   IDRLS-04  users: a context reads the directory; an account updates only
 *             itself; nobody (itself included) can set is_platform_owner or
 *             insert a platform owner; the Platform Owner can update others
 *             but still reads none of their credentials
 *   IDRLS-05  users inserts: only as the new id's own context, or an
 *             `invited` account inside a tenant context
 *   IDRLS-06  the pre-authentication resolvers return an owner id and
 *             nothing else, are not executable by PUBLIC, and a wrong key
 *             resolves to nothing
 *   IDRLS-07  the roster's session count answers only a viewer allowed to see
 *             that learner, and never exposes a row
 *   IDRLS-08  the password credential is not on the directory row: every
 *             `users.password_hash` is NULL, and a legacy write to it (the
 *             previous release during a deploy) lands in `user_credentials`
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { IdentityResolver } from '../src/identity/repositories/identity-resolver';
import { hashOpaqueToken } from '../src/identity/utils/opaque-token.util';

jest.setTimeout(120000);
const PASSWORD = 'correct-horse-battery-idrls';

const CREDENTIAL_TABLES = [
  'refresh_tokens',
  'password_reset_tokens',
  'email_verification_tokens',
  'user_two_factor',
  'two_factor_recovery_codes',
  'user_auth_identities',
  'user_credentials',
] as const;
const IDENTITY_TABLES = ['users', ...CREDENTIAL_TABLES] as const;

interface Seeded {
  readonly userId: string;
  readonly email: string;
  readonly refreshHash: string;
  readonly resetHash: string;
  readonly verificationHash: string;
  readonly subject: string;
}

describe('Identity tables — row-level security (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let tenancy: TenancyContextService;
  let resolver: IdentityResolver;
  let alice: Seeded;
  let bob: Seeded;
  let owner: string;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    tenancy = app.get(TenancyContextService, { strict: false });
    resolver = app.get(IdentityResolver, { strict: false });
    alice = await seedAccount('idrls-alice');
    bob = await seedAccount('idrls-bob');
    owner = (await seedAccount('idrls-owner')).userId;
    await admin.user.update({ where: { id: owner }, data: { isPlatformOwner: true } });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  /** A real account (registered through the API) plus one row in every credential table, written past RLS. */
  async function seedAccount(label: string): Promise<Seeded> {
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const { id: userId } = await admin.user.findUniqueOrThrow({ where: { email } });
    const refreshHash = hashOpaqueToken(`refresh-${randomUUID()}`);
    const resetHash = hashOpaqueToken(`reset-${randomUUID()}`);
    const verificationHash = hashOpaqueToken(`verify-${randomUUID()}`);
    const subject = `google-subject-${randomUUID()}`;
    const later = new Date(Date.now() + 3_600_000);
    await admin.refreshToken.create({
      data: { userId, tokenHash: refreshHash, sessionId: randomUUID(), expiresAt: later },
    });
    await admin.passwordResetToken.create({
      data: { userId, tokenHash: resetHash, expiresAt: later },
    });
    await admin.emailVerificationToken.create({
      data: { userId, tokenHash: verificationHash, expiresAt: later },
    });
    await admin.userTwoFactor.create({
      data: { userId, encryptedSecret: 'sealed-secret-fixture' },
    });
    await admin.twoFactorRecoveryCode.create({
      data: { userId, codeHash: hashOpaqueToken(`rc-${randomUUID()}`) },
    });
    await admin.userAuthIdentity.create({
      data: { userId, provider: 'google', providerSubject: subject, emailAtLink: email },
    });
    return { userId, email, refreshHash, resetHash, verificationHash, subject };
  }

  const asUser = <T>(
    userId: string,
    work: Parameters<TenancyContextService['runInUserContext']>[1],
  ) => tenancy.runInUserContext(userId, work) as Promise<T>;

  const countFor = (table: string, userId: string, as: string | null) => {
    const sql = `SELECT count(*)::int AS n FROM "${table}" WHERE "${table === 'users' ? 'id' : 'user_id'}" = $1`;
    const run = (
      tx: Parameters<Parameters<TenancyContextService['runInUserContext']>[1]>[0],
    ) => tx.$queryRawUnsafe<{ n: number }[]>(sql, userId).then((rows) => rows[0].n);
    return as ? asUser<number>(as, run) : tenancy.runWithoutContext(run);
  };

  it('IDRLS-01 — the app role cannot bypass: NOSUPERUSER NOBYPASSRLS, not the owner, FORCE RLS on every table', async () => {
    const [role] = await tenancy.runWithoutContext(
      (tx) =>
        tx.$queryRaw<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
        SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(role).toEqual({ rolname: 'atlas_app', rolsuper: false, rolbypassrls: false });
    const tables = await admin.$queryRaw<
      { relname: string; owner: string; rls: boolean; force: boolean }[]
    >`
      SELECT c.relname, pg_get_userbyid(c.relowner) AS owner,
             c.relrowsecurity AS rls, c.relforcerowsecurity AS force
        FROM pg_class c
       WHERE c.relname = ANY(${[...IDENTITY_TABLES]}::text[]) AND c.relkind = 'r'`;
    expect(tables).toHaveLength(IDENTITY_TABLES.length);
    for (const table of tables) {
      expect({ table: table.relname, rls: table.rls, force: table.force }).toEqual({
        table: table.relname,
        rls: true,
        force: true,
      });
      expect(table.owner).not.toBe('atlas_app');
    }
    // No permissive "anything goes" policy on any of them.
    const open = await admin.$queryRaw<{ policyname: string }[]>`
      SELECT policyname FROM pg_policies
       WHERE tablename = ANY(${[...IDENTITY_TABLES]}::text[])
         AND (qual = 'true' OR with_check = 'true')`;
    expect(open).toEqual([]);
  });

  it('IDRLS-02 — without a context, no identity row is visible', async () => {
    for (const table of IDENTITY_TABLES) {
      expect({ table, n: await countFor(table, alice.userId, null) }).toEqual({
        table,
        n: 0,
      });
    }
    const all = await tenancy.runWithoutContext(
      (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "users"`,
    );
    expect(all[0].n).toBe(0);
  });

  it('IDRLS-03 — credential tables: own rows only; another account is invisible and untouchable', async () => {
    for (const table of CREDENTIAL_TABLES) {
      // Everything Alice owns is visible to her (registration may have
      // written more than the one fixture row, e.g. a verification link).
      const stored = await admin.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM "${table}" WHERE "user_id" = $1`,
        alice.userId,
      );
      expect(stored[0].n).toBeGreaterThanOrEqual(1);
      expect({ table, own: await countFor(table, alice.userId, alice.userId) }).toEqual({
        table,
        own: stored[0].n,
      });
      expect({ table, other: await countFor(table, bob.userId, alice.userId) }).toEqual({
        table,
        other: 0,
      });
      // Even the Platform Owner reads no one else's credentials.
      expect({ table, po: await countFor(table, bob.userId, owner) }).toEqual({
        table,
        po: 0,
      });
    }

    // Updates and deletes aimed at Bob, from Alice's context, match nothing.
    const touched = await asUser<number[]>(alice.userId, async (tx) => [
      await tx.$executeRaw`UPDATE "refresh_tokens" SET "revoked_at" = now() WHERE "user_id" = ${bob.userId}`,
      await tx.$executeRaw`UPDATE "user_two_factor" SET "last_time_step" = 1 WHERE "user_id" = ${bob.userId}`,
      await tx.$executeRaw`DELETE FROM "two_factor_recovery_codes" WHERE "user_id" = ${bob.userId}`,
      await tx.$executeRaw`DELETE FROM "user_auth_identities" WHERE "user_id" = ${bob.userId}`,
      await tx.$executeRaw`UPDATE "password_reset_tokens" SET "used_at" = now() WHERE "user_id" = ${bob.userId}`,
      await tx.$executeRaw`UPDATE "email_verification_tokens" SET "used_at" = now() WHERE "user_id" = ${bob.userId}`,
    ]);
    expect(touched).toEqual([0, 0, 0, 0, 0, 0]);
    const bobsSession = await admin.refreshToken.findFirstOrThrow({
      where: { userId: bob.userId },
    });
    expect(bobsSession.revokedAt).toBeNull();
    expect(
      await admin.twoFactorRecoveryCode.count({ where: { userId: bob.userId } }),
    ).toBe(1);

    // A row cannot be written for Bob from Alice's context…
    await expect(
      asUser(alice.userId, (tx) =>
        tx.refreshToken.create({
          data: {
            userId: bob.userId,
            tokenHash: hashOpaqueToken(randomUUID()),
            sessionId: randomUUID(),
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
    // …nor can Alice's own row be handed to Bob on its way out.
    await expect(
      asUser(
        alice.userId,
        (tx) =>
          tx.$executeRaw`UPDATE "user_auth_identities" SET "user_id" = ${bob.userId} WHERE "user_id" = ${alice.userId}`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('IDRLS-04 — users: a context reads the directory, but writes only itself; privilege columns are out of reach', async () => {
    // Directory read inside a context.
    expect(await countFor('users', bob.userId, alice.userId)).toBe(1);

    // Alice cannot change Bob…
    const changed = await asUser<number>(
      alice.userId,
      (tx) =>
        tx.$executeRaw`UPDATE "users" SET "name" = 'hijacked', "email" = ${`x-${randomUUID()}@evil.test`} WHERE "id" = ${bob.userId}`,
    );
    expect(changed).toBe(0);
    const deleted = await asUser<number>(
      alice.userId,
      (tx) => tx.$executeRaw`DELETE FROM "users" WHERE "id" = ${bob.userId}`,
    );
    expect(deleted).toBe(0);
    expect(
      (await admin.user.findUniqueOrThrow({ where: { id: bob.userId } })).name,
    ).not.toBe('hijacked');

    // …can change herself…
    await asUser(
      alice.userId,
      (tx) =>
        tx.$executeRaw`UPDATE "users" SET "name" = 'Alice Renamed' WHERE "id" = ${alice.userId}`,
    );
    expect(
      (await admin.user.findUniqueOrThrow({ where: { id: alice.userId } })).name,
    ).toBe('Alice Renamed');

    // …but cannot make herself a platform owner (column privilege).
    await expect(
      asUser(
        alice.userId,
        (tx) =>
          tx.$executeRaw`UPDATE "users" SET "is_platform_owner" = true WHERE "id" = ${alice.userId}`,
      ),
    ).rejects.toThrow(/permission denied/);
    expect(
      (await admin.user.findUniqueOrThrow({ where: { id: alice.userId } }))
        .isPlatformOwner,
    ).toBe(false);

    // The Platform Owner can change another account (the console's path)…
    const suspended = await asUser<number>(
      owner,
      (tx) =>
        tx.$executeRaw`UPDATE "users" SET "status" = 'suspended' WHERE "id" = ${bob.userId}`,
    );
    expect(suspended).toBe(1);
    await admin.user.update({ where: { id: bob.userId }, data: { status: 'active' } });
    // …but not promote anybody either.
    await expect(
      asUser(
        owner,
        (tx) =>
          tx.$executeRaw`UPDATE "users" SET "is_platform_owner" = true WHERE "id" = ${bob.userId}`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('IDRLS-05 — users inserts: only in the new id’s own context, or an invited account inside a tenant', async () => {
    const insert =
      (id: string, status: string, platformOwner = false) =>
      (tx: Parameters<Parameters<TenancyContextService['runInUserContext']>[1]>[0]) =>
        tx.$executeRaw`
        INSERT INTO "users" ("id", "email", "name", "status", "is_platform_owner", "updated_at")
        VALUES (${id}, ${uniqueTestEmail('idrls-ins')}, 'Inserted', ${status}::"user_account_status", ${platformOwner}, now())`;

    // Own context: allowed.
    const self = randomUUID();
    await asUser(self, insert(self, 'active'));
    expect(await admin.user.count({ where: { id: self } })).toBe(1);

    // Someone else's id from Alice's context: refused.
    const other = randomUUID();
    await expect(asUser(alice.userId, insert(other, 'active'))).rejects.toThrow(
      /row-level security/,
    );
    // A platform owner, even in its own context: refused.
    const po = randomUUID();
    await expect(asUser(po, insert(po, 'active', true))).rejects.toThrow(
      /row-level security/,
    );
    // No context at all: refused.
    const anon = randomUUID();
    await expect(tenancy.runWithoutContext(insert(anon, 'active'))).rejects.toThrow(
      /row-level security/,
    );

    // A tenant context may create an INVITED account (staff member-add)…
    const orgId = randomUUID();
    const invited = randomUUID();
    await tenancy.runInTenantContext(orgId, insert(invited, 'invited'));
    expect((await admin.user.findUniqueOrThrow({ where: { id: invited } })).status).toBe(
      'invited',
    );
    // …but not an active one.
    const active = randomUUID();
    await expect(
      tenancy.runInTenantContext(orgId, insert(active, 'active')),
    ).rejects.toThrow(/row-level security/);
    await admin.user.deleteMany({ where: { id: { in: [self, invited] } } });
  });

  it('IDRLS-06 — the pre-authentication resolvers return an owner id only, and only to atlas_app', async () => {
    expect(await resolver.userIdByEmail(alice.email)).toBe(alice.userId);
    expect(await resolver.refreshTokenOwner(bob.refreshHash)).toBe(bob.userId);
    expect(await resolver.passwordResetTokenOwner(alice.resetHash)).toBe(alice.userId);
    expect(await resolver.emailVerificationTokenOwner(bob.verificationHash)).toBe(
      bob.userId,
    );
    expect(await resolver.identityOwner('google', alice.subject)).toBe(alice.userId);
    expect(await resolver.platformOwnerId()).toEqual(expect.any(String));

    // Wrong keys resolve to nothing — a hash is not a prefix search.
    expect(await resolver.userIdByEmail(uniqueTestEmail('nobody'))).toBeNull();
    expect(await resolver.refreshTokenOwner(bob.refreshHash.slice(0, -1))).toBeNull();
    expect(await resolver.passwordResetTokenOwner(hashOpaqueToken('guess'))).toBeNull();
    expect(await resolver.identityOwner('google', 'unknown-subject')).toBeNull();

    // Every resolver returns a single text value: no hash, secret or row.
    const functions = await admin.$queryRaw<
      {
        proname: string;
        result: string;
        definer: boolean;
        public_exec: boolean;
        app_exec: boolean;
      }[]
    >`
      SELECT p.proname,
             pg_get_function_result(p.oid) AS result,
             p.prosecdef AS definer,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
             has_function_privilege('atlas_app', p.oid, 'EXECUTE') AS app_exec
        FROM pg_proc p
       WHERE p.proname = ANY(${[
         'auth_user_id_by_email',
         'auth_refresh_token_owner',
         'auth_password_reset_token_owner',
         'auth_email_verification_token_owner',
         'auth_identity_owner',
         'platform_owner_user_id',
       ]}::text[])`;
    expect(functions).toHaveLength(6);
    for (const fn of functions) {
      expect(fn).toEqual({
        proname: fn.proname,
        result: 'text',
        definer: true,
        public_exec: false,
        app_exec: true,
      });
    }
  });

  it('IDRLS-07 — the roster session count is 0 for anyone not admitted to that learner', async () => {
    const academyId = randomUUID();
    const counts = await Promise.all(
      [alice.userId, bob.userId, owner].map((viewer) =>
        asUser<{ count: number }[]>(
          viewer,
          (tx) =>
            tx.$queryRaw`SELECT academy_student_session_count(${academyId}, ${alice.userId}) AS count`,
        ),
      ),
    );
    expect(counts.map((rows) => rows[0].count)).toEqual([0, 0, 0]);
    const [fn] = await admin.$queryRaw<{ result: string; public_exec: boolean }[]>`
      SELECT pg_get_function_result(p.oid) AS result,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
        FROM pg_proc p WHERE p.proname = 'academy_student_session_count'`;
    expect(fn).toEqual({ result: 'integer', public_exec: false });
  });

  it('IDRLS-08 — the directory holds no credential; a legacy write is captured into user_credentials', async () => {
    const [left] = await admin.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "users" WHERE "password_hash" IS NOT NULL`;
    expect(left.n).toBe(0);
    // A directory read inside a context carries no credential column at all.
    const row = await asUser<Record<string, unknown>[]>(
      alice.userId,
      (tx) => tx.$queryRaw`SELECT "password_hash" FROM "users" WHERE "id" = ${bob.userId}`,
    );
    expect(row[0].password_hash ?? null).toBeNull();

    // The previous release (during the seconds of a deploy) still writes the
    // column: an UPDATE lands in user_credentials and the column stays NULL.
    const legacy = '$argon2id$v=19$m=19456,t=2,p=1$bGVnYWN5$bGVnYWN5aGFzaA';
    await asUser(
      alice.userId,
      (tx) =>
        tx.$executeRaw`UPDATE "users" SET "password_hash" = ${legacy} WHERE "id" = ${alice.userId}`,
    );
    expect(
      (await admin.userCredential.findUniqueOrThrow({ where: { userId: alice.userId } }))
        .passwordHash,
    ).toBe(legacy);
    const [after] = await admin.$queryRaw<{ h: string | null }[]>`
      SELECT "password_hash" AS h FROM "users" WHERE "id" = ${alice.userId}`;
    expect(after.h).toBeNull();

    // A legacy INSERT (a registration by the previous release) likewise.
    const id = randomUUID();
    await asUser(
      id,
      (tx) =>
        tx.$executeRaw`
        INSERT INTO "users" ("id", "email", "password_hash", "name", "updated_at")
        VALUES (${id}, ${uniqueTestEmail('idrls-legacy')}, ${legacy}, 'Legacy', now())`,
    );
    expect(
      (await admin.userCredential.findUniqueOrThrow({ where: { userId: id } }))
        .passwordHash,
    ).toBe(legacy);
    const [inserted] = await admin.$queryRaw<{ h: string | null }[]>`
      SELECT "password_hash" AS h FROM "users" WHERE "id" = ${id}`;
    expect(inserted.h).toBeNull();
    await admin.user.delete({ where: { id } });

    // The credential table refuses anything that is not an Argon2 hash.
    await expect(
      admin.userCredential.update({
        where: { userId: alice.userId },
        data: { passwordHash: 'plaintext' },
      }),
    ).rejects.toThrow(/user_credentials_password_hash_argon2/);
  });
});
