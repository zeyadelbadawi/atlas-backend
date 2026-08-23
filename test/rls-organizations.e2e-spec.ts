/**
 * Direct PostgreSQL/RLS proof — master plan §7 "RLS is the primary
 * defense, not a backstop", §16, §18. Every test in this file talks to
 * Postgres directly through the app's own `PrismaService` (which connects
 * as the restricted `atlas_app` role, never the migration superuser) and
 * `TenancyContextService` (pure session-variable plumbing, not an
 * authorization decision). No `OrganizationMembershipGuard`, no
 * `OrganizationsService`, no HTTP request, no application-layer
 * authorization check is involved anywhere in this file — if any test here
 * passes, it is because the database itself refused the row, independent
 * of whether any guard or service code is even correct.
 *
 * Covers:
 *  - Tenant-scoped SELECT isolation (organizations, organization_memberships).
 *  - Fail-closed behavior with no session variable set.
 *  - The three attack vectors identified in review and their fixes:
 *    (1) creating an organization with an arbitrary owner_user_id,
 *    (2) injecting a membership row for another user,
 *    (3) self-joining an organization the caller does not own.
 *  - The one legitimate INSERT path both narrowed policies still allow.
 */
import { INestApplication } from '@nestjs/common';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { PrismaService } from '../src/database/prisma.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';

describe('Row-Level Security — organizations / organization_memberships (direct, no guards)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenancyContext: TenancyContextService;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    prisma = testApp.prisma;
    tenancyContext = app.get(TenancyContextService, { strict: false });
  });

  afterAll(async () => {
    await app.close();
  });

  /** Users are platform-scoped (no RLS) — created directly, no fixture RLS concerns. */
  async function createUser(label: string): Promise<{ id: string; email: string }> {
    const email = uniqueTestEmail(label);
    const user = await prisma.user.create({
      data: { email, passwordHash: 'x', name: label },
    });
    return { id: user.id, email };
  }

  /** Legitimate bootstrap path: both `app.current_organization_id` (= the org's own pre-generated id) and `app.current_user_id` (= the owner) set together — the one shape the narrowed INSERT policies allow. */
  async function createOrgOwnedBy(ownerId: string, slugLabel: string) {
    return prisma.$transaction(async (tx) => {
      const id = crypto.randomUUID();
      await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${id}, true)`;
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${ownerId}, true)`;
      const org = await tx.organization.create({
        data: {
          id,
          name: slugLabel,
          slug: `${slugLabel}-${Date.now()}`,
          ownerUserId: ownerId,
        },
      });
      const membership = await tx.organizationMembership.create({
        data: { organizationId: org.id, userId: ownerId, role: 'owner', isPrimary: true },
      });
      return { org, membership };
    });
  }

  it('SELECT: an active tenant context only ever sees its own organization row', async () => {
    const owner1 = await createUser('rls-select-owner1');
    const owner2 = await createUser('rls-select-owner2');
    const { org: org1 } = await createOrgOwnedBy(owner1.id, 'rls-select-org1');
    const { org: org2 } = await createOrgOwnedBy(owner2.id, 'rls-select-org2');

    const visibleInOrg1Context = await tenancyContext.runInTenantContext(org1.id, (tx) =>
      tx.organization.findMany({ where: { id: { in: [org1.id, org2.id] } } }),
    );

    expect(visibleInOrg1Context.map((o) => o.id)).toEqual([org1.id]);
  });

  it('SELECT: with no session variable set at all, every row is invisible (fail-closed)', async () => {
    const owner = await createUser('rls-noctx-owner');
    const { org } = await createOrgOwnedBy(owner.id, 'rls-noctx-org');

    // Deliberately does NOT go through `runInTenantContext`/`runInUserContext`.
    const rows = await prisma.organization.findMany({ where: { id: org.id } });
    expect(rows).toEqual([]);
  });

  it('ATTACK 1 (blocked): cannot create an organization with an arbitrary owner_user_id', async () => {
    const caller = await createUser('rls-atk1-caller');
    const victim = await createUser('rls-atk1-victim');

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_user_id', ${caller.id}, true)`;
        return tx.organization.create({
          data: {
            name: 'Attacker Attempt',
            slug: `rls-atk1-${Date.now()}`,
            ownerUserId: victim.id, // attacker-controlled — not the caller.
          },
        });
      }),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it('ATTACK 2 (blocked): cannot inject a membership row for another user', async () => {
    const caller = await createUser('rls-atk2-caller');
    const otherUser = await createUser('rls-atk2-other');
    const { org: victimOrg } = await createOrgOwnedBy(otherUser.id, 'rls-atk2-org');

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_user_id', ${caller.id}, true)`;
        return tx.organizationMembership.create({
          data: { organizationId: victimOrg.id, userId: otherUser.id, role: 'owner' },
        });
      }),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it('ATTACK 3 (blocked): cannot self-join an organization the caller does not own', async () => {
    const caller = await createUser('rls-atk3-caller');
    const owner = await createUser('rls-atk3-owner');
    const { org: someoneElsesOrg } = await createOrgOwnedBy(owner.id, 'rls-atk3-org');

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_user_id', ${caller.id}, true)`;
        return tx.organizationMembership.create({
          data: { organizationId: someoneElsesOrg.id, userId: caller.id, role: 'owner' },
        });
      }),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it('LEGITIMATE (allowed): a user can create an organization and a membership row for themselves', async () => {
    const owner = await createUser('rls-legit-owner');
    const { org, membership } = await createOrgOwnedBy(owner.id, 'rls-legit-org');

    expect(org.ownerUserId).toBe(owner.id);
    expect(membership.userId).toBe(owner.id);
    expect(membership.organizationId).toBe(org.id);
  });
});
