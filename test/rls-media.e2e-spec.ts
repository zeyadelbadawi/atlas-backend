/**
 * Direct PostgreSQL/RLS proof for `media_assets` (master plan §21 Phase
 * P8) — mirrors `rls-courses.e2e-spec.ts`'s exact pattern: every test
 * talks to Postgres directly through the app's own `PrismaService`
 * (connected as the restricted `atlas_app` role) and
 * `TenancyContextService`. No guard, no service, no HTTP request is
 * involved anywhere in this file.
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { uniqueTestEmail, createTestApp } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import { PrismaService } from '../src/database/prisma.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import type { PrismaClient } from '@prisma/client';

describe('Row-Level Security — media_assets (direct, no guards)', () => {
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

  /** Mirrors `rls-courses.e2e-spec.ts`'s `createOrgOwnedBy` exactly. */
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
    return tenancyContext.runInTenantContext(organizationId, (tx) =>
      tx.academy.create({
        data: { organizationId, name: label, slug: `${label}-${Date.now()}` },
      }),
    );
  }

  async function createMediaAsset(
    organizationId: string,
    academyId: string,
    label: string,
  ) {
    return tenancyContext.runInTenantContext(organizationId, (tx) =>
      tx.mediaAsset.create({
        data: {
          academyId,
          type: 'image',
          fileName: `${label}.png`,
          storageKey: `academies/${academyId}/${randomUUID()}.png`,
          url: `http://localhost:9000/test/${label}.png`,
          mimeType: 'image/png',
          sizeBytes: 1024n,
        },
      }),
    );
  }

  it('SELECT: with no session variable set at all, a media asset is invisible (fail-closed)', async () => {
    const owner = await createUser('rls-media-noctx-owner');
    const org = await createOrgOwnedBy(owner.id, 'rls-media-noctx');
    const academy = await createAcademyFor(org.id, 'rls-media-noctx');
    const asset = await createMediaAsset(org.id, academy.id, 'rls-media-noctx');

    const rows = await prisma.mediaAsset.findMany({ where: { id: asset.id } });
    expect(rows).toEqual([]);
  });

  it("SELECT: Organization A's session context never sees Organization B's media, and vice versa", async () => {
    const ownerA = await createUser('rls-media-cross-a');
    const ownerB = await createUser('rls-media-cross-b');
    const orgA = await createOrgOwnedBy(ownerA.id, 'rls-media-cross-orgA');
    const orgB = await createOrgOwnedBy(ownerB.id, 'rls-media-cross-orgB');
    const academyA = await createAcademyFor(orgA.id, 'rls-media-cross-academyA');
    const academyB = await createAcademyFor(orgB.id, 'rls-media-cross-academyB');
    const assetA = await createMediaAsset(
      orgA.id,
      academyA.id,
      'rls-media-cross-a-asset',
    );
    const assetB = await createMediaAsset(
      orgB.id,
      academyB.id,
      'rls-media-cross-b-asset',
    );

    const visibleToA = await tenancyContext.runInTenantContext(orgA.id, (tx) =>
      tx.mediaAsset.findMany({ where: { id: { in: [assetA.id, assetB.id] } } }),
    );
    expect(visibleToA.map((a) => a.id)).toEqual([assetA.id]);

    const visibleToB = await tenancyContext.runInTenantContext(orgB.id, (tx) =>
      tx.mediaAsset.findMany({ where: { id: { in: [assetA.id, assetB.id] } } }),
    );
    expect(visibleToB.map((a) => a.id)).toEqual([assetB.id]);
  });

  it('ATTACK (blocked): cannot insert a media asset under a different organization than the active tenant context', async () => {
    const attackerOwner = await createUser('rls-atk-media-attacker');
    const victimOwner = await createUser('rls-atk-media-victim');
    const attackerOrg = await createOrgOwnedBy(
      attackerOwner.id,
      'rls-atk-media-attacker-org',
    );
    const victimOrg = await createOrgOwnedBy(victimOwner.id, 'rls-atk-media-victim-org');
    const victimAcademy = await createAcademyFor(
      victimOrg.id,
      'rls-atk-media-victim-academy',
    );

    await expect(
      tenancyContext.runInTenantContext(attackerOrg.id, (tx) =>
        tx.mediaAsset.create({
          data: {
            academyId: victimAcademy.id,
            type: 'image',
            fileName: 'hijack.png',
            storageKey: `academies/${victimAcademy.id}/hijack.png`,
            url: 'http://localhost:9000/test/hijack.png',
            mimeType: 'image/png',
            sizeBytes: 1024n,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it("ATTACK (blocked): cannot archive/update Organization B's media asset from Organization A's tenant context, even with the exact real id", async () => {
    const ownerA = await createUser('rls-atk-media-update-a');
    const ownerB = await createUser('rls-atk-media-update-b');
    const orgA = await createOrgOwnedBy(ownerA.id, 'rls-atk-media-update-orgA');
    const orgB = await createOrgOwnedBy(ownerB.id, 'rls-atk-media-update-orgB');
    const academyB = await createAcademyFor(orgB.id, 'rls-atk-media-update-academyB');
    const assetB = await createMediaAsset(
      orgB.id,
      academyB.id,
      'rls-atk-media-update-b-asset',
    );

    const result = await tenancyContext.runInTenantContext(orgA.id, (tx) =>
      tx.mediaAsset.updateMany({
        where: { id: assetB.id },
        data: { status: 'archived' },
      }),
    );
    expect(result.count).toBe(0);

    const stillActive = await admin.mediaAsset.findUniqueOrThrow({
      where: { id: assetB.id },
    });
    expect(stillActive.status).toBe('active');
  });

  it('no DELETE policy exists on media_assets — a direct DELETE affects zero rows even under the correct tenant context', async () => {
    const owner = await createUser('rls-media-no-delete-owner');
    const org = await createOrgOwnedBy(owner.id, 'rls-media-no-delete');
    const academy = await createAcademyFor(org.id, 'rls-media-no-delete');
    const asset = await createMediaAsset(org.id, academy.id, 'rls-media-no-delete-asset');

    const result = await tenancyContext.runInTenantContext(org.id, (tx) =>
      tx.mediaAsset.deleteMany({ where: { id: asset.id } }),
    );
    expect(result.count).toBe(0);

    const stillThere = await admin.mediaAsset.findUnique({ where: { id: asset.id } });
    expect(stillThere).not.toBeNull();
  });
});
