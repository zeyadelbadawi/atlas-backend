/**
 * Direct PostgreSQL/RLS proof for `subdomain_allocations`/
 * `domain_connections`, plus the two `SECURITY DEFINER` functions this
 * phase introduces (master plan §21 Phase P11) — mirrors
 * `rls-website.e2e-spec.ts`'s exact pattern: every test talks to Postgres
 * directly through the app's own `PrismaService` (connected as the
 * restricted `atlas_app` role) and `TenancyContextService`. No guard, no
 * service, no HTTP request is involved anywhere in this file.
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { uniqueTestEmail, createTestApp } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import { PrismaService } from '../src/database/prisma.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import type { PrismaClient } from '@prisma/client';

describe('Row-Level Security — subdomain_allocations / domain_connections (direct, no guards)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: PrismaClient;
  let tenancyContext: TenancyContextService;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    prisma = testApp.prisma;
    admin = createAdminPrisma();
    tenancyContext = app.get(TenancyContextService, { strict: false });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  async function createUser(label: string): Promise<{ id: string }> {
    const user = await prisma.user.create({
      data: { email: uniqueTestEmail(label), passwordHash: 'x', name: label },
    });
    return { id: user.id };
  }

  async function createOrgOwnedBy(ownerId: string, slugLabel: string) {
    return prisma.$transaction(async (tx) => {
      const id = randomUUID();
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
      await tx.organizationMembership.create({
        data: { organizationId: org.id, userId: ownerId, role: 'owner', isPrimary: true },
      });
      return org;
    });
  }

  async function createAcademyFor(organizationId: string, label: string) {
    return tenancyContext.runInTenantContext(organizationId, async (tx) => {
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: organizationId },
      });
      const academy = await tx.academy.create({
        data: { organizationId, name: label, slug: `${label}-${Date.now()}` },
      });
      // Phase 1 (Extended Scope, dependency A) — reproduces the real
      // `AcademiesService.create`'s auto-granted owner membership, which
      // the new `is_academy_member`-gated policies below now require.
      await tx.academyMember.create({
        data: {
          academyId: academy.id,
          userId: org.ownerUserId,
          role: 'owner',
          status: 'active',
        },
      });
      return academy;
    });
  }

  /** Phase 1 (Extended Scope, dependency A) — see `rls-website.e2e-spec.ts`'s identical helper. */
  async function resolveAcademyOwnerId(
    organizationId: string,
    academyId: string,
  ): Promise<string> {
    const membership = await tenancyContext.runInTenantContext(organizationId, (tx) =>
      tx.academyMember.findFirst({ where: { academyId, role: 'owner' } }),
    );
    if (!membership)
      throw new Error(`No owner membership found for academy ${academyId}`);
    return membership.userId;
  }

  async function createDomainConnection(
    organizationId: string,
    academyId: string,
    hostname: string,
  ) {
    const ownerId = await resolveAcademyOwnerId(organizationId, academyId);
    return tenancyContext.runInTenantAndUserContext(organizationId, ownerId, (tx) =>
      tx.domainConnection.create({
        data: { academyId, hostname, status: 'connected' },
      }),
    );
  }

  it('SELECT: with no session variable set at all, a domain_connections row is invisible (fail-closed)', async () => {
    const owner = await createUser('rls-domain-noctx-owner');
    const org = await createOrgOwnedBy(owner.id, 'rls-domain-noctx');
    const academy = await createAcademyFor(org.id, 'rls-domain-noctx');
    const connection = await createDomainConnection(
      org.id,
      academy.id,
      `noctx-${Date.now()}.test`,
    );

    const rows = await prisma.domainConnection.findMany({ where: { id: connection.id } });
    expect(rows).toEqual([]);
  });

  it("SELECT: Organization A's session context never sees Organization B's domain connection, and vice versa", async () => {
    const ownerA = await createUser('rls-domain-cross-a');
    const ownerB = await createUser('rls-domain-cross-b');
    const orgA = await createOrgOwnedBy(ownerA.id, 'rls-domain-cross-orgA');
    const orgB = await createOrgOwnedBy(ownerB.id, 'rls-domain-cross-orgB');
    const academyA = await createAcademyFor(orgA.id, 'rls-domain-cross-academyA');
    const academyB = await createAcademyFor(orgB.id, 'rls-domain-cross-academyB');
    const connectionA = await createDomainConnection(
      orgA.id,
      academyA.id,
      `a-${Date.now()}.test`,
    );
    const connectionB = await createDomainConnection(
      orgB.id,
      academyB.id,
      `b-${Date.now()}.test`,
    );

    const visibleToA = await tenancyContext.runInTenantAndUserContext(
      orgA.id,
      ownerA.id,
      (tx) =>
        tx.domainConnection.findMany({
          where: { id: { in: [connectionA.id, connectionB.id] } },
        }),
    );
    expect(visibleToA.map((c) => c.id)).toEqual([connectionA.id]);

    const visibleToB = await tenancyContext.runInTenantAndUserContext(
      orgB.id,
      ownerB.id,
      (tx) =>
        tx.domainConnection.findMany({
          where: { id: { in: [connectionA.id, connectionB.id] } },
        }),
    );
    expect(visibleToB.map((c) => c.id)).toEqual([connectionB.id]);
  });

  it("SELECT: a Manager assigned only to Academy A never sees Academy B's domain connection, even though both share the same Organization (Phase 1, Extended Scope, dependency A)", async () => {
    const owner = await createUser('rls-domain-same-org-owner');
    const manager = await createUser('rls-domain-same-org-manager');
    const org = await createOrgOwnedBy(owner.id, 'rls-domain-same-org');
    const academyA = await createAcademyFor(org.id, 'rls-domain-same-org-academyA');
    const academyB = await createAcademyFor(org.id, 'rls-domain-same-org-academyB');
    const connectionA = await createDomainConnection(
      org.id,
      academyA.id,
      `same-a-${Date.now()}.test`,
    );
    const connectionB = await createDomainConnection(
      org.id,
      academyB.id,
      `same-b-${Date.now()}.test`,
    );

    await tenancyContext.runInTenantContext(org.id, (tx) =>
      tx.academyMember.create({
        data: {
          academyId: academyA.id,
          userId: manager.id,
          role: 'manager',
          status: 'active',
        },
      }),
    );

    const visibleToManager = await tenancyContext.runInTenantAndUserContext(
      org.id,
      manager.id,
      (tx) =>
        tx.domainConnection.findMany({
          where: { id: { in: [connectionA.id, connectionB.id] } },
        }),
    );
    expect(visibleToManager.map((c) => c.id)).toEqual([connectionA.id]);
  });

  it('ATTACK (blocked): cannot insert a domain_connections row under a different organization than the active tenant context', async () => {
    const attackerOwner = await createUser('rls-atk-domain-attacker');
    const victimOwner = await createUser('rls-atk-domain-victim');
    const attackerOrg = await createOrgOwnedBy(
      attackerOwner.id,
      'rls-atk-domain-attacker-org',
    );
    const victimOrg = await createOrgOwnedBy(victimOwner.id, 'rls-atk-domain-victim-org');
    const victimAcademy = await createAcademyFor(
      victimOrg.id,
      'rls-atk-domain-victim-academy',
    );

    await expect(
      tenancyContext.runInTenantContext(attackerOrg.id, (tx) =>
        tx.domainConnection.create({
          data: {
            academyId: victimAcademy.id,
            hostname: `hijack-${Date.now()}.test`,
            status: 'connected',
          },
        }),
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it("ATTACK (blocked): cannot claim Organization B's Academy for a subdomain allocation from Organization A's tenant context", async () => {
    const attackerOwner = await createUser('rls-atk-subdomain-attacker');
    const victimOwner = await createUser('rls-atk-subdomain-victim');
    const attackerOrg = await createOrgOwnedBy(
      attackerOwner.id,
      'rls-atk-subdomain-attacker-org',
    );
    const victimOrg = await createOrgOwnedBy(
      victimOwner.id,
      'rls-atk-subdomain-victim-org',
    );
    const victimAcademy = await createAcademyFor(
      victimOrg.id,
      'rls-atk-subdomain-victim-academy',
    );

    await expect(
      tenancyContext.runInTenantContext(attackerOrg.id, (tx) =>
        tx.subdomainAllocation.create({
          data: {
            academyId: victimAcademy.id,
            subdomain: `hijack-${Date.now()}`,
            status: 'assigned',
          },
        }),
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it("ATTACK (blocked): cannot update Organization B's domain_connections row from Organization A's tenant context, even with the exact real id", async () => {
    const ownerA = await createUser('rls-atk-domain-update-a');
    const ownerB = await createUser('rls-atk-domain-update-b');
    const orgA = await createOrgOwnedBy(ownerA.id, 'rls-atk-domain-update-orgA');
    const orgB = await createOrgOwnedBy(ownerB.id, 'rls-atk-domain-update-orgB');
    const academyB = await createAcademyFor(orgB.id, 'rls-atk-domain-update-academyB');
    const connectionB = await createDomainConnection(
      orgB.id,
      academyB.id,
      `updateb-${Date.now()}.test`,
    );

    const result = await tenancyContext.runInTenantContext(orgA.id, (tx) =>
      tx.domainConnection.updateMany({
        where: { id: connectionB.id },
        data: { status: 'disconnected' },
      }),
    );
    expect(result.count).toBe(0);

    const stillConnected = await admin.domainConnection.findUniqueOrThrow({
      where: { id: connectionB.id },
    });
    expect(stillConnected.status).toBe('connected');
  });

  it('a duplicate hostname is rejected at the database level, even across two different, correctly-scoped organizations', async () => {
    const ownerA = await createUser('rls-domain-dup-a');
    const ownerB = await createUser('rls-domain-dup-b');
    const orgA = await createOrgOwnedBy(ownerA.id, 'rls-domain-dup-orgA');
    const orgB = await createOrgOwnedBy(ownerB.id, 'rls-domain-dup-orgB');
    const academyA = await createAcademyFor(orgA.id, 'rls-domain-dup-academyA');
    const academyB = await createAcademyFor(orgB.id, 'rls-domain-dup-academyB');
    const sharedHostname = `duplicate-${Date.now()}.test`;

    await createDomainConnection(orgA.id, academyA.id, sharedHostname);

    await expect(
      createDomainConnection(orgB.id, academyB.id, sharedHostname),
    ).rejects.toThrow(/unique constraint/i);
  });

  it('no DELETE policy exists on domain_connections — a direct DELETE affects zero rows even under the correct tenant context', async () => {
    const owner = await createUser('rls-domain-no-delete-owner');
    const org = await createOrgOwnedBy(owner.id, 'rls-domain-no-delete');
    const academy = await createAcademyFor(org.id, 'rls-domain-no-delete');
    const connection = await createDomainConnection(
      org.id,
      academy.id,
      `nodelete-${Date.now()}.test`,
    );

    const result = await tenancyContext.runInTenantContext(org.id, (tx) =>
      tx.domainConnection.deleteMany({ where: { id: connection.id } }),
    );
    expect(result.count).toBe(0);

    const stillThere = await admin.domainConnection.findUnique({
      where: { id: connection.id },
    });
    expect(stillThere).not.toBeNull();
  });

  it('no DELETE policy exists on subdomain_allocations — a direct DELETE affects zero rows even under the correct tenant context', async () => {
    const owner = await createUser('rls-subdomain-no-delete-owner');
    const org = await createOrgOwnedBy(owner.id, 'rls-subdomain-no-delete');
    const academy = await createAcademyFor(org.id, 'rls-subdomain-no-delete');
    const ownerId = await resolveAcademyOwnerId(org.id, academy.id);
    const allocation = await tenancyContext.runInTenantAndUserContext(
      org.id,
      ownerId,
      (tx) =>
        tx.subdomainAllocation.create({
          data: {
            academyId: academy.id,
            subdomain: `nodelete-${Date.now()}`,
            status: 'assigned',
          },
        }),
    );

    const result = await tenancyContext.runInTenantContext(org.id, (tx) =>
      tx.subdomainAllocation.deleteMany({ where: { id: allocation.id } }),
    );
    expect(result.count).toBe(0);

    const stillThere = await admin.subdomainAllocation.findUnique({
      where: { id: allocation.id },
    });
    expect(stillThere).not.toBeNull();
  });

  describe('SECURITY DEFINER functions (the one explicit, documented RLS exception)', () => {
    it('resolve_public_hostname resolves a real connected custom domain across tenants, through the ordinary restricted connection, with NO session variable set', async () => {
      const owner = await createUser('rls-fn-hostname-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-fn-hostname-org');
      const academy = await createAcademyFor(org.id, 'rls-fn-hostname-academy');
      const hostname = `fn-resolve-${Date.now()}.test`;
      await createDomainConnection(org.id, academy.id, hostname);

      // No session variable set at all — an ordinary query against
      // `domain_connections` would return nothing (proven above); the
      // function must still resolve correctly.
      const rows = await prisma.$queryRaw<
        { academy_id: string; organization_id: string }[]
      >(Prisma.sql`SELECT * FROM resolve_public_hostname(${hostname}, ${null})`);
      expect(rows).toHaveLength(1);
      expect(rows[0].academy_id).toBe(academy.id);
      expect(rows[0].organization_id).toBe(org.id);
    });

    it('resolve_public_hostname returns nothing for an unconnected/pending domain_connections row', async () => {
      const owner = await createUser('rls-fn-pending-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-fn-pending-org');
      const academy = await createAcademyFor(org.id, 'rls-fn-pending-academy');
      const hostname = `fn-pending-${Date.now()}.test`;
      const pendingOwnerId = await resolveAcademyOwnerId(org.id, academy.id);
      await tenancyContext.runInTenantAndUserContext(org.id, pendingOwnerId, (tx) =>
        tx.domainConnection.create({
          data: { academyId: academy.id, hostname, status: 'verification_required' },
        }),
      );

      const rows = await prisma.$queryRaw<{ academy_id: string }[]>(
        Prisma.sql`SELECT * FROM resolve_public_hostname(${hostname}, ${null})`,
      );
      expect(rows).toHaveLength(0);
    });

    it('resolve_public_hostname resolves a real assigned subdomain by label across tenants', async () => {
      const owner = await createUser('rls-fn-subdomain-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-fn-subdomain-org');
      const academy = await createAcademyFor(org.id, 'rls-fn-subdomain-academy');
      const label = `fnsub${Date.now()}`;
      const subdomainOwnerId = await resolveAcademyOwnerId(org.id, academy.id);
      await tenancyContext.runInTenantAndUserContext(org.id, subdomainOwnerId, (tx) =>
        tx.subdomainAllocation.create({
          data: { academyId: academy.id, subdomain: label, status: 'assigned' },
        }),
      );

      const rows = await prisma.$queryRaw<{ academy_id: string }[]>(
        Prisma.sql`SELECT * FROM resolve_public_hostname(${'irrelevant.test'}, ${label})`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].academy_id).toBe(academy.id);
    });

    it('resolve_academy_organization resolves a real academy id to its organization id, with NO session variable set', async () => {
      const owner = await createUser('rls-fn-academyorg-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-fn-academyorg-org');
      const academy = await createAcademyFor(org.id, 'rls-fn-academyorg-academy');

      const rows = await prisma.$queryRaw<{ organization_id: string }[]>(
        Prisma.sql`SELECT * FROM resolve_academy_organization(${academy.id})`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].organization_id).toBe(org.id);
    });

    it('resolve_academy_organization returns nothing for a fabricated academy id', async () => {
      const rows = await prisma.$queryRaw<{ organization_id: string }[]>(
        Prisma.sql`SELECT * FROM resolve_academy_organization(${'00000000-0000-0000-0000-000000000000'})`,
      );
      expect(rows).toHaveLength(0);
    });
  });
});
