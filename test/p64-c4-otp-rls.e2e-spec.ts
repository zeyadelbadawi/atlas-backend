/**
 * P64 Communications C4 — RLS on the authentication-factor tables, proved
 * DIRECTLY against Postgres rather than through the service.
 *
 * This suite exists because of a real defect. The foundation migration
 * gave `auth_email_challenges` and `trusted_devices` permissive
 * `USING (true)` SELECT/UPDATE policies beside their self-scoped ones,
 * and PostgreSQL OR-combines permissive policies — so `USING (true)` did
 * not sit alongside `user_id = current_user`, it replaced it. RLS imposed
 * no cross-user constraint at all on the two tables that hold login codes
 * and device trust, leaving the service's `user_id` predicate as the only
 * thing between two accounts.
 *
 * Going through the service would NOT catch that: the service adds its own
 * predicate and would pass either way. So every case below sets the
 * session GUC by hand and issues raw SQL, which is the only way to observe
 * what the database itself enforces.
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';

jest.setTimeout(60000);
const PASSWORD = 'correct-horse-battery';

describe('P64 C4 — RLS on auth_email_challenges and trusted_devices (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let tenancy: TenancyContextService;
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    tenancy = app.get(TenancyContextService, { strict: false });
    alice = await signUp('c4rls-alice');
    bob = await signUp('c4rls-bob');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  async function signUp(label: string): Promise<string> {
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return signIn.body.user.id as string;
  }

  /** A trusted-device row for `userId`, written past RLS with the admin connection. */
  async function seedDevice(userId: string): Promise<string> {
    const id = randomUUID();
    await admin.$executeRaw`
      INSERT INTO "trusted_devices" ("id", "user_id", "surface", "token_hash", "label", "expires_at", "created_at")
      VALUES (${id}, ${userId}, 'management', ${`hash-${id}`}, 'Test device', now() + INTERVAL '30 days', now())
    `;
    return id;
  }

  describe('trusted_devices', () => {
    it('C4-RLS-1: a user sees their own device rows', async () => {
      const id = await seedDevice(alice);
      const rows = await tenancy.runInUserContext(alice, (tx) =>
        tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "trusted_devices" WHERE "id" = ${id}`,
      );
      expect(rows).toHaveLength(1);
    });

    it("C4-RLS-2: a user CANNOT see another user's device rows", async () => {
      const id = await seedDevice(alice);
      const rows = await tenancy.runInUserContext(bob, (tx) =>
        tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "trusted_devices" WHERE "id" = ${id}`,
      );
      // Before the tightening this returned the row: `_system_select
      // USING (true)` OR-ed past `_self_select`.
      expect(rows).toHaveLength(0);
    });

    it("C4-RLS-3: a user CANNOT revoke another user's device by updating it", async () => {
      const id = await seedDevice(alice);
      const updated = await tenancy.runInUserContext(bob, (tx) =>
        tx.$executeRaw`UPDATE "trusted_devices" SET "revoked_at" = now() WHERE "id" = ${id}`,
      );
      expect(updated).toBe(0);
      const still = await admin.$queryRaw<
        { revoked_at: Date | null }[]
      >`SELECT "revoked_at" FROM "trusted_devices" WHERE "id" = ${id}`;
      expect(still[0]?.revoked_at).toBeNull();
    });

    it('C4-RLS-4: a user cannot mint a device row that belongs to someone else', async () => {
      await expect(
        tenancy.runInUserContext(bob, (tx) =>
          tx.$executeRaw`
            INSERT INTO "trusted_devices" ("id", "user_id", "surface", "token_hash", "label", "expires_at", "created_at")
            VALUES (${randomUUID()}, ${alice}, 'management', ${'forged'}, 'Forged', now() + INTERVAL '30 days', now())
          `,
        ),
      ).rejects.toThrow();
    });
  });

  describe('auth_email_challenges', () => {
    async function seedChallenge(userId: string): Promise<string> {
      const id = randomUUID();
      await admin.$executeRaw`
        INSERT INTO "auth_email_challenges"
          ("id", "user_id", "surface", "code_hash", "salt", "attempts", "expires_at", "created_at")
        VALUES (${id}, ${userId}, 'management', ${`hash-${id}`}, ${'salt'}, 0, now() + INTERVAL '10 minutes', now())
      `;
      return id;
    }

    it('C4-RLS-5: a user sees their own challenge', async () => {
      const id = await seedChallenge(alice);
      const rows = await tenancy.runInUserContext(alice, (tx) =>
        tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "auth_email_challenges" WHERE "id" = ${id}`,
      );
      expect(rows).toHaveLength(1);
    });

    it("C4-RLS-6: a user CANNOT read another user's login challenge", async () => {
      const id = await seedChallenge(alice);
      const rows = await tenancy.runInUserContext(bob, (tx) =>
        tx.$queryRaw<
          { id: string; code_hash: string }[]
        >`SELECT "id", "code_hash" FROM "auth_email_challenges" WHERE "id" = ${id}`,
      );
      expect(rows).toHaveLength(0);
    });

    it("C4-RLS-7: a user CANNOT consume or tamper with another user's challenge", async () => {
      const id = await seedChallenge(alice);
      const updated = await tenancy.runInUserContext(bob, (tx) =>
        tx.$executeRaw`UPDATE "auth_email_challenges" SET "attempts" = 0, "consumed_at" = NULL WHERE "id" = ${id}`,
      );
      expect(updated).toBe(0);
    });

    it('C4-RLS-8: even the Platform Owner cannot read a live login code', async () => {
      // Device metadata is legitimate support data; a live authentication
      // code is not, so no platform policy was added for this table.
      const id = await seedChallenge(alice);
      const ownerEmail = uniqueTestEmail('c4rls-owner');
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ name: 'c4rls-owner', email: ownerEmail, password: PASSWORD })
        .expect(201);
      const owner = await admin.user.update({
        where: { email: ownerEmail },
        data: { isPlatformOwner: true },
        select: { id: true },
      });

      const rows = await tenancy.runInUserContext(owner.id, (tx) =>
        tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "auth_email_challenges" WHERE "id" = ${id}`,
      );
      expect(rows).toHaveLength(0);
    });
  });
});
