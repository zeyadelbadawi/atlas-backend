/**
 * Direct PostgreSQL/RLS proof for `website_configurations`/`website_pages`
 * (master plan §21 Phase P9) — mirrors `rls-media.e2e-spec.ts`'s exact
 * pattern: every test talks to Postgres directly through the app's own
 * `PrismaService` (connected as the restricted `atlas_app` role) and
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

describe('Row-Level Security — website_configurations / website_pages (direct, no guards)', () => {
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
    return tenancyContext.runInTenantContext(organizationId, (tx) =>
      tx.academy.create({
        data: { organizationId, name: label, slug: `${label}-${Date.now()}` },
      }),
    );
  }

  async function createConfiguration(organizationId: string, academyId: string) {
    return tenancyContext.runInTenantContext(organizationId, (tx) =>
      tx.websiteConfiguration.create({
        data: {
          academyId,
          themeKey: 'modern-education',
          themeVersion: 1,
          brand: {
            primaryColor: '221 83% 53%',
            secondaryColor: '221 83% 53%',
            accentColor: '221 83% 53%',
          },
          seo: {},
          navigation: [],
          header: {},
          footer: { groups: [], socialLinks: [] },
        },
      }),
    );
  }

  async function createPage(organizationId: string, academyId: string, label: string) {
    return tenancyContext.runInTenantContext(organizationId, (tx) =>
      tx.websitePage.create({
        data: {
          academyId,
          pageType: 'custom',
          title: label,
          slug: `${label}-${randomUUID()}`,
          seo: {},
          sections: [],
        },
      }),
    );
  }

  it('SELECT: with no session variable set at all, a configuration/page is invisible (fail-closed)', async () => {
    const owner = await createUser('rls-website-noctx-owner');
    const org = await createOrgOwnedBy(owner.id, 'rls-website-noctx');
    const academy = await createAcademyFor(org.id, 'rls-website-noctx');
    const config = await createConfiguration(org.id, academy.id);
    const page = await createPage(org.id, academy.id, 'rls-website-noctx-page');

    const configRows = await prisma.websiteConfiguration.findMany({
      where: { academyId: config.academyId },
    });
    expect(configRows).toEqual([]);
    const pageRows = await prisma.websitePage.findMany({ where: { id: page.id } });
    expect(pageRows).toEqual([]);
  });

  it("SELECT: Organization A's session context never sees Organization B's website data, and vice versa", async () => {
    const ownerA = await createUser('rls-website-cross-a');
    const ownerB = await createUser('rls-website-cross-b');
    const orgA = await createOrgOwnedBy(ownerA.id, 'rls-website-cross-orgA');
    const orgB = await createOrgOwnedBy(ownerB.id, 'rls-website-cross-orgB');
    const academyA = await createAcademyFor(orgA.id, 'rls-website-cross-academyA');
    const academyB = await createAcademyFor(orgB.id, 'rls-website-cross-academyB');
    const pageA = await createPage(orgA.id, academyA.id, 'rls-website-cross-a-page');
    const pageB = await createPage(orgB.id, academyB.id, 'rls-website-cross-b-page');

    const visibleToA = await tenancyContext.runInTenantContext(orgA.id, (tx) =>
      tx.websitePage.findMany({ where: { id: { in: [pageA.id, pageB.id] } } }),
    );
    expect(visibleToA.map((p) => p.id)).toEqual([pageA.id]);

    const visibleToB = await tenancyContext.runInTenantContext(orgB.id, (tx) =>
      tx.websitePage.findMany({ where: { id: { in: [pageA.id, pageB.id] } } }),
    );
    expect(visibleToB.map((p) => p.id)).toEqual([pageB.id]);
  });

  it('ATTACK (blocked): cannot insert a website_page under a different organization than the active tenant context', async () => {
    const attackerOwner = await createUser('rls-atk-website-attacker');
    const victimOwner = await createUser('rls-atk-website-victim');
    const attackerOrg = await createOrgOwnedBy(
      attackerOwner.id,
      'rls-atk-website-attacker-org',
    );
    const victimOrg = await createOrgOwnedBy(
      victimOwner.id,
      'rls-atk-website-victim-org',
    );
    const victimAcademy = await createAcademyFor(
      victimOrg.id,
      'rls-atk-website-victim-academy',
    );

    await expect(
      tenancyContext.runInTenantContext(attackerOrg.id, (tx) =>
        tx.websitePage.create({
          data: {
            academyId: victimAcademy.id,
            pageType: 'custom',
            title: 'hijack',
            slug: `hijack-${randomUUID()}`,
            seo: {},
            sections: [],
          },
        }),
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it("ATTACK (blocked): cannot update Organization B's website configuration from Organization A's tenant context, even with the exact real id", async () => {
    const ownerA = await createUser('rls-atk-website-update-a');
    const ownerB = await createUser('rls-atk-website-update-b');
    const orgA = await createOrgOwnedBy(ownerA.id, 'rls-atk-website-update-orgA');
    const orgB = await createOrgOwnedBy(ownerB.id, 'rls-atk-website-update-orgB');
    const academyB = await createAcademyFor(orgB.id, 'rls-atk-website-update-academyB');
    const configB = await createConfiguration(orgB.id, academyB.id);

    const result = await tenancyContext.runInTenantContext(orgA.id, (tx) =>
      tx.websiteConfiguration.updateMany({
        where: { academyId: configB.academyId },
        data: { status: 'published' },
      }),
    );
    expect(result.count).toBe(0);

    const stillDraft = await admin.websiteConfiguration.findUniqueOrThrow({
      where: { academyId: configB.academyId },
    });
    expect(stillDraft.status).toBe('draft');
  });

  it('no DELETE policy exists on website_configurations — a direct DELETE affects zero rows even under the correct tenant context', async () => {
    const owner = await createUser('rls-website-config-no-delete-owner');
    const org = await createOrgOwnedBy(owner.id, 'rls-website-config-no-delete');
    const academy = await createAcademyFor(org.id, 'rls-website-config-no-delete');
    const config = await createConfiguration(org.id, academy.id);

    const result = await tenancyContext.runInTenantContext(org.id, (tx) =>
      tx.websiteConfiguration.deleteMany({ where: { academyId: config.academyId } }),
    );
    expect(result.count).toBe(0);

    const stillThere = await admin.websiteConfiguration.findUnique({
      where: { academyId: config.academyId },
    });
    expect(stillThere).not.toBeNull();
  });

  it("ATTACK (blocked): cannot DELETE Organization B's website_page from Organization A's tenant context — the DELETE policy is real but tenant-scoped, never a cross-tenant hole", async () => {
    const ownerA = await createUser('rls-atk-website-delete-a');
    const ownerB = await createUser('rls-atk-website-delete-b');
    const orgA = await createOrgOwnedBy(ownerA.id, 'rls-atk-website-delete-orgA');
    const orgB = await createOrgOwnedBy(ownerB.id, 'rls-atk-website-delete-orgB');
    const academyB = await createAcademyFor(orgB.id, 'rls-atk-website-delete-academyB');
    const pageB = await createPage(orgB.id, academyB.id, 'rls-atk-website-delete-b-page');

    const result = await tenancyContext.runInTenantContext(orgA.id, (tx) =>
      tx.websitePage.deleteMany({ where: { id: pageB.id } }),
    );
    expect(result.count).toBe(0);

    const stillThere = await admin.websitePage.findUnique({ where: { id: pageB.id } });
    expect(stillThere).not.toBeNull();
  });

  it('within the owning tenant context, DELETE on website_pages genuinely removes the row (a deliberate, real hard-delete capability, unlike media_assets)', async () => {
    const owner = await createUser('rls-website-real-delete-owner');
    const org = await createOrgOwnedBy(owner.id, 'rls-website-real-delete');
    const academy = await createAcademyFor(org.id, 'rls-website-real-delete');
    const page = await createPage(org.id, academy.id, 'rls-website-real-delete-page');

    const result = await tenancyContext.runInTenantContext(org.id, (tx) =>
      tx.websitePage.deleteMany({ where: { id: page.id } }),
    );
    expect(result.count).toBe(1);

    const gone = await admin.websitePage.findUnique({ where: { id: page.id } });
    expect(gone).toBeNull();
  });
});
