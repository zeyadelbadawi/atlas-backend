/**
 * B0-OC-01 — removing the Platform Owner role from unsecured accounts,
 * against real Postgres on the owner connection (the only connection that
 * can change `is_platform_owner`), with real session
 * revocation (database rows + the Redis denylist the guard reads).
 *
 * Pinned here:
 *   - the dry run reports real facts (live sessions, audit rows, owned
 *     organization) and changes nothing;
 *   - every refusal: operator without a confirmed authenticator, the
 *     operator's own account, a secured target, a non-owner, an unknown or
 *     malformed id;
 *   - apply removes the role, writes one audit row per target, revokes the
 *     sessions, and the target's token no longer opens a Platform route;
 *   - apply re-checks inside the transaction (a target that enrolled after
 *     the dry run is refused, nothing changed), and is not repeatable.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma, seedOrganizationWithOwner } from './utils/db-admin';
import { RedisService } from '../src/redis/redis.service';
import { SESSION_REVOKED_KEY_PREFIX } from '../src/identity/services/session-revocation.service';
import {
  applyRoleRemoval,
  planRoleRemoval,
  RoleRemovalRefusedError,
  type RoleRemovalDeps,
} from '../src/identity/services/platform-owner-role-removal';

describe('Platform Owner role removal (e2e, owner connection)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let deps: RoleRemovalDeps;

  async function signUp(label: string) {
    const email = uniqueTestEmail(label);
    const password = 'correct-horse-battery';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(200);
    return {
      userId: signIn.body.user.id as string,
      accessToken: signIn.body.accessToken as string,
    };
  }

  async function platformOwner(label: string, secured: boolean) {
    const user = await signUp(label);
    await admin.user.update({
      where: { id: user.userId },
      data: { isPlatformOwner: true },
    });
    if (secured) {
      // A confirmed factor row; the secret is never read by this code path.
      await admin.userTwoFactor.create({
        data: {
          userId: user.userId,
          encryptedSecret: 'fixture',
          confirmedAt: new Date(),
        },
      });
    }
    return user;
  }

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    await testApp.flushRateLimitKeys();
    admin = createAdminPrisma();
    const redis = app.get(RedisService).getClient();
    deps = {
      // What the CLI does: the access-token denylist the guard reads.
      denylistSessions: async (sessionIds) => {
        for (const sessionId of sessionIds) {
          await redis.set(`${SESSION_REVOKED_KEY_PREFIX}${sessionId}`, '1', 'EX', 900);
        }
      },
    };
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  it('dry run reports real facts and changes nothing', async () => {
    const actor = await platformOwner('porr-actor-1', true);
    const target = await platformOwner('porr-target-1', false);
    const org = await seedOrganizationWithOwner(
      admin,
      target.userId,
      'porr-target-1-org',
    );

    const plan = await planRoleRemoval(admin, {
      actorId: actor.userId,
      targetIds: [target.userId],
    });

    expect(plan.refusals).toEqual([]);
    expect(plan.securedPlatformOwnersAfter).toBe(plan.securedPlatformOwnersBefore);
    const facts = plan.targets[0];
    expect(facts.id).toBe(target.userId);
    expect(facts.email).toMatch(/^.{2}…\(\d+\)@/);
    expect(facts.totp).toBe('none');
    expect(facts.liveSessions).toBeGreaterThanOrEqual(1);
    expect(facts.ownedOrganizations.map((o) => o.id)).toEqual([org.id]);
    const user = await admin.user.findUniqueOrThrow({ where: { id: target.userId } });
    expect(user.isPlatformOwner).toBe(true);
  });

  it('refuses an unsecured operator, self, a secured target, a non-owner and bad ids', async () => {
    const securedActor = await platformOwner('porr-actor-2', true);
    const unsecuredActor = await platformOwner('porr-actor-3', false);
    const securedTarget = await platformOwner('porr-target-2', true);
    const ordinary = await signUp('porr-ordinary');
    const codes = async (actorId: string, targetIds: string[]) =>
      (await planRoleRemoval(admin, { actorId, targetIds })).refusals.map((r) => r.code);

    expect(await codes(unsecuredActor.userId, [ordinary.userId])).toContain(
      'actor_without_confirmed_totp',
    );
    expect(await codes(securedActor.userId, [securedActor.userId])).toContain(
      'target_is_actor',
    );
    expect(await codes(securedActor.userId, [securedTarget.userId])).toContain(
      'target_has_confirmed_totp',
    );
    expect(await codes(securedActor.userId, [ordinary.userId])).toContain(
      'target_not_platform_owner',
    );
    expect(
      await codes(securedActor.userId, ['00000000-0000-4000-8000-000000000000']),
    ).toContain('target_not_found');
    expect(await codes(securedActor.userId, ['not-a-uuid'])).toContain('invalid_id');
    expect(await codes(securedActor.userId, [])).toContain('no_targets');
  });

  it('applies: role removed, one audit row, sessions revoked, Platform route closed', async () => {
    const actor = await platformOwner('porr-actor-4', true);
    const target = await platformOwner('porr-target-4', false);
    const server = app.getHttpServer();
    await request(server)
      .get(`/platform-user-management/${actor.userId}/deletion-plan`)
      .set('Authorization', `Bearer ${target.accessToken}`)
      .expect(200);

    const result = await applyRoleRemoval(
      admin,
      {
        actorId: actor.userId,
        targetIds: [target.userId],
        reason: 'e2e: unused account',
      },
      deps,
    );

    expect(result.removed).toEqual([target.userId]);
    expect(result.sessionsRevoked[target.userId]).toBeGreaterThanOrEqual(1);
    const user = await admin.user.findUniqueOrThrow({ where: { id: target.userId } });
    expect(user.isPlatformOwner).toBe(false);
    expect(user.status).toBe('active');
    const audit = await admin.auditLogEntry.findMany({
      where: {
        action: 'platform_owner.role_removed_by_operator',
        targetId: target.userId,
      },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].actorUserId).toBe(actor.userId);
    expect(audit[0].context).toMatchObject({
      reason: 'e2e: unused account',
      hadConfirmedAuthenticator: false,
    });
    expect(
      await admin.refreshToken.count({
        where: { userId: target.userId, revokedAt: null },
      }),
    ).toBe(0);
    const after = await request(server)
      .get(`/platform-user-management/${actor.userId}/deletion-plan`)
      .set('Authorization', `Bearer ${target.accessToken}`);
    expect([401, 403]).toContain(after.status);

    // Not repeatable: the account is no longer a Platform Owner.
    await expect(
      applyRoleRemoval(
        admin,
        { actorId: actor.userId, targetIds: [target.userId], reason: 'again' },
        deps,
      ),
    ).rejects.toBeInstanceOf(RoleRemovalRefusedError);
  });

  it('re-checks inside the transaction: a target that enrolled after the dry run is refused', async () => {
    const actor = await platformOwner('porr-actor-5', true);
    const target = await platformOwner('porr-target-5', false);
    const plan = await planRoleRemoval(admin, {
      actorId: actor.userId,
      targetIds: [target.userId],
    });
    expect(plan.refusals).toEqual([]);

    await admin.userTwoFactor.create({
      data: {
        userId: target.userId,
        encryptedSecret: 'fixture',
        confirmedAt: new Date(),
      },
    });
    await expect(
      applyRoleRemoval(
        admin,
        { actorId: actor.userId, targetIds: [target.userId], reason: 'race' },
        deps,
      ),
    ).rejects.toBeInstanceOf(RoleRemovalRefusedError);
    const user = await admin.user.findUniqueOrThrow({ where: { id: target.userId } });
    expect(user.isPlatformOwner).toBe(true);
    expect(
      await admin.auditLogEntry.count({
        where: {
          action: 'platform_owner.role_removed_by_operator',
          targetId: target.userId,
        },
      }),
    ).toBe(0);
  });

  it('refuses to apply without a reason', async () => {
    const actor = await platformOwner('porr-actor-6', true);
    const target = await platformOwner('porr-target-6', false);
    await expect(
      applyRoleRemoval(
        admin,
        { actorId: actor.userId, targetIds: [target.userId], reason: ' ' },
        deps,
      ),
    ).rejects.toThrow('a reason is required');
  });
});
