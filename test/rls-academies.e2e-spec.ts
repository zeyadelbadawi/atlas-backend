/**
 * Direct PostgreSQL/RLS proof for `academies`/`academy_members` — mirrors
 * `rls-organizations.e2e-spec.ts` exactly: every test talks to Postgres
 * directly through the app's own `PrismaService` (connected as the
 * restricted `atlas_app` role, never the migration superuser) and
 * `TenancyContextService` (pure session-variable plumbing). No
 * `AcademyScopeGuard`, no `AcademiesService`, no HTTP request, no
 * application-layer authorization check is involved anywhere in this file
 * — if a test here passes, it is because the database itself refused the
 * row, independent of whether any guard or service code is even correct.
 *
 * Covers exactly what was manually proven via `docker exec ... psql` before
 * any application code was written (see `Reports/PROGRESS.md`'s P3 entry)
 * — this file is that same proof, made permanent and CI-enforced:
 *  - Tenant-scoped SELECT isolation, transitively for `academy_members`.
 *  - Fail-closed behavior with no session variable set.
 *  - The bootstrap policy (`academies_org_member_select`) used by
 *    `AcademyScopeGuard` to resolve an academy's organization id from only
 *    an academy id.
 *  - The attack vectors: cross-org academy insert, cross-org
 *    academy_member insert, academy_member referencing a nonexistent
 *    academy, organization_id reassignment via UPDATE, and updating a row
 *    outside the active tenant context.
 *  - The legitimate INSERT/UPDATE paths the narrowed policies still allow.
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { PrismaService } from '../src/database/prisma.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';

describe('Row-Level Security — academies / academy_members (direct, no guards)', () => {
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

  async function createUser(label: string): Promise<{ id: string }> {
    const user = await prisma.user.create({
      data: { email: uniqueTestEmail(label), passwordHash: 'x', name: label },
    });
    return { id: user.id };
  }

  /** Legitimate bootstrap path: org id + owner user id set together in one transaction — the one shape the narrowed org INSERT policies allow (see `rls-organizations.e2e-spec.ts`). */
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

  /** Legitimate academy creation, exercised the same way `AcademiesService.create` does: `runInTenantContext`, academy insert + owner-member insert in the same transaction. */
  async function createAcademyOwnedBy(
    organizationId: string,
    ownerId: string,
    slugLabel: string,
  ) {
    return tenancyContext.runInTenantContext(organizationId, async (tx) => {
      const academy = await tx.academy.create({
        data: { organizationId, name: slugLabel, slug: `${slugLabel}-${Date.now()}` },
      });
      await tx.academyMember.create({
        data: { academyId: academy.id, userId: ownerId, role: 'owner' },
      });
      return academy;
    });
  }

  it('SELECT: an active tenant context only ever sees its own academy row', async () => {
    const owner1 = await createUser('rls-acad-select-owner1');
    const owner2 = await createUser('rls-acad-select-owner2');
    const org1 = await createOrgOwnedBy(owner1.id, 'rls-acad-select-org1');
    const org2 = await createOrgOwnedBy(owner2.id, 'rls-acad-select-org2');
    const academy1 = await createAcademyOwnedBy(org1.id, owner1.id, 'rls-acad-select-a1');
    const academy2 = await createAcademyOwnedBy(org2.id, owner2.id, 'rls-acad-select-a2');

    const visible = await tenancyContext.runInTenantContext(org1.id, (tx) =>
      tx.academy.findMany({ where: { id: { in: [academy1.id, academy2.id] } } }),
    );

    expect(visible.map((a) => a.id)).toEqual([academy1.id]);
  });

  it('SELECT: with no session variable set at all, every academy row is invisible (fail-closed)', async () => {
    const owner = await createUser('rls-acad-noctx-owner');
    const org = await createOrgOwnedBy(owner.id, 'rls-acad-noctx-org');
    const academy = await createAcademyOwnedBy(org.id, owner.id, 'rls-acad-noctx-a');

    const rows = await prisma.academy.findMany({ where: { id: academy.id } });
    expect(rows).toEqual([]);
  });

  it("SELECT (transitive): academy_members is visible only through its academy's owning organization context", async () => {
    const owner1 = await createUser('rls-mem-select-owner1');
    const owner2 = await createUser('rls-mem-select-owner2');
    const org1 = await createOrgOwnedBy(owner1.id, 'rls-mem-select-org1');
    const org2 = await createOrgOwnedBy(owner2.id, 'rls-mem-select-org2');
    const academy1 = await createAcademyOwnedBy(org1.id, owner1.id, 'rls-mem-select-a1');

    const visibleInOwnOrg = await tenancyContext.runInTenantContext(org1.id, (tx) =>
      tx.academyMember.findMany({ where: { academyId: academy1.id } }),
    );
    expect(visibleInOwnOrg).toHaveLength(1);
    expect(visibleInOwnOrg[0].userId).toBe(owner1.id);

    const visibleInOtherOrg = await tenancyContext.runInTenantContext(org2.id, (tx) =>
      tx.academyMember.findMany({ where: { academyId: academy1.id } }),
    );
    expect(visibleInOtherOrg).toEqual([]);
  });

  it('BOOTSTRAP (must succeed): user-context lookup resolves organization_id for an academy the caller org-belongs-to', async () => {
    const owner = await createUser('rls-bootstrap-owner');
    const org = await createOrgOwnedBy(owner.id, 'rls-bootstrap-org');
    const academy = await createAcademyOwnedBy(org.id, owner.id, 'rls-bootstrap-a');

    const bootstrapped = await tenancyContext.runInUserContext(owner.id, (tx) =>
      tx.academy.findUnique({ where: { id: academy.id } }),
    );

    expect(bootstrapped?.organizationId).toBe(org.id);
  });

  it('BOOTSTRAP (must fail): a user with no membership in the owning organization cannot bootstrap-resolve the academy', async () => {
    const owner = await createUser('rls-bootstrap-neg-owner');
    const outsider = await createUser('rls-bootstrap-neg-outsider');
    const org = await createOrgOwnedBy(owner.id, 'rls-bootstrap-neg-org');
    const academy = await createAcademyOwnedBy(org.id, owner.id, 'rls-bootstrap-neg-a');

    const bootstrapped = await tenancyContext.runInUserContext(outsider.id, (tx) =>
      tx.academy.findUnique({ where: { id: academy.id } }),
    );

    expect(bootstrapped).toBeNull();
  });

  it('ATTACK (blocked): cannot create an academy in a different organization than the active tenant context', async () => {
    const owner1 = await createUser('rls-atk-academy-owner1');
    const owner2 = await createUser('rls-atk-academy-owner2');
    const org1 = await createOrgOwnedBy(owner1.id, 'rls-atk-academy-org1');
    const org2 = await createOrgOwnedBy(owner2.id, 'rls-atk-academy-org2');

    await expect(
      tenancyContext.runInTenantContext(org1.id, (tx) =>
        tx.academy.create({
          data: {
            organizationId: org2.id, // attacker-controlled — not the active context.
            name: 'Attacker Academy',
            slug: `rls-atk-academy-${Date.now()}`,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it("ATTACK (blocked): cannot inject an academy_member row into another organization's academy", async () => {
    const owner1 = await createUser('rls-atk-member-owner1');
    const owner2 = await createUser('rls-atk-member-owner2');
    const org1 = await createOrgOwnedBy(owner1.id, 'rls-atk-member-org1');
    const org2 = await createOrgOwnedBy(owner2.id, 'rls-atk-member-org2');
    const academy2 = await createAcademyOwnedBy(org2.id, owner2.id, 'rls-atk-member-a2');

    await expect(
      tenancyContext.runInTenantContext(org1.id, (tx) =>
        tx.academyMember.create({
          data: { academyId: academy2.id, userId: owner1.id, role: 'owner' },
        }),
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it('ATTACK (blocked): cannot inject an academy_member row referencing a nonexistent academy', async () => {
    const owner = await createUser('rls-atk-ghost-owner');
    const org = await createOrgOwnedBy(owner.id, 'rls-atk-ghost-org');

    await expect(
      tenancyContext.runInTenantContext(org.id, (tx) =>
        tx.academyMember.create({
          data: { academyId: randomUUID(), userId: owner.id, role: 'owner' },
        }),
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it('ATTACK (blocked): cannot reassign organization_id on an existing academy via UPDATE', async () => {
    const owner1 = await createUser('rls-atk-reassign-owner1');
    const owner2 = await createUser('rls-atk-reassign-owner2');
    const org1 = await createOrgOwnedBy(owner1.id, 'rls-atk-reassign-org1');
    const org2 = await createOrgOwnedBy(owner2.id, 'rls-atk-reassign-org2');
    const academy1 = await createAcademyOwnedBy(
      org1.id,
      owner1.id,
      'rls-atk-reassign-a1',
    );

    await expect(
      tenancyContext.runInTenantContext(org1.id, (tx) =>
        tx.academy.update({
          where: { id: academy1.id },
          data: { organizationId: org2.id },
        }),
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it('ATTACK (no-op): an UPDATE targeting a row outside the active tenant context affects zero rows', async () => {
    const owner1 = await createUser('rls-atk-outside-owner1');
    const owner2 = await createUser('rls-atk-outside-owner2');
    const org1 = await createOrgOwnedBy(owner1.id, 'rls-atk-outside-org1');
    const org2 = await createOrgOwnedBy(owner2.id, 'rls-atk-outside-org2');
    const academy2 = await createAcademyOwnedBy(org2.id, owner2.id, 'rls-atk-outside-a2');

    const affected = await tenancyContext.runInTenantContext(org1.id, (tx) =>
      tx.academy.updateMany({
        where: { id: academy2.id },
        data: { name: 'Hijacked' },
      }),
    );
    expect(affected.count).toBe(0);

    const stillIntact = await tenancyContext.runInTenantContext(org2.id, (tx) =>
      tx.academy.findUniqueOrThrow({ where: { id: academy2.id } }),
    );
    expect(stillIntact.name).toBe(academy2.name);
  });

  it('LEGITIMATE (allowed): creating an academy and its owner-member row within the active tenant context', async () => {
    const owner = await createUser('rls-legit-academy-owner');
    const org = await createOrgOwnedBy(owner.id, 'rls-legit-academy-org');

    const academy = await createAcademyOwnedBy(org.id, owner.id, 'rls-legit-academy-a');
    expect(academy.organizationId).toBe(org.id);

    const member = await tenancyContext.runInTenantContext(org.id, (tx) =>
      tx.academyMember.findFirstOrThrow({
        where: { academyId: academy.id, userId: owner.id },
      }),
    );
    expect(member.role).toBe('owner');
  });

  it('LEGITIMATE (allowed): updating an academy within its own tenant context, without touching organization_id', async () => {
    const owner = await createUser('rls-legit-update-owner');
    const org = await createOrgOwnedBy(owner.id, 'rls-legit-update-org');
    const academy = await createAcademyOwnedBy(org.id, owner.id, 'rls-legit-update-a');

    const updated = await tenancyContext.runInTenantContext(org.id, (tx) =>
      tx.academy.update({ where: { id: academy.id }, data: { name: 'Renamed' } }),
    );
    expect(updated.name).toBe('Renamed');
    expect(updated.organizationId).toBe(org.id);
  });
});
