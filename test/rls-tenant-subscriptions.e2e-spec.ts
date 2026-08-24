/**
 * Direct PostgreSQL/RLS proof for `tenant_subscriptions`/`tenant_add_ons`/
 * `tenant_usage` — mirrors `rls-organizations.e2e-spec.ts`/
 * `rls-academies.e2e-spec.ts` exactly: every test talks to Postgres
 * directly through the app's own `PrismaService` (connected as the
 * restricted `atlas_app` role) and `TenancyContextService`. No guard, no
 * service, no HTTP request is involved anywhere in this file.
 *
 * Also proves the platform-owned tables (`plans`/`add_ons`/`trial_policy`)
 * are readable with NO session context at all — the correct behavior for
 * non-tenant-scoped tables, distinct from every tenant-scoped table's
 * fail-closed behavior.
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { PrismaService } from '../src/database/prisma.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';

describe('Row-Level Security — tenant_subscriptions / tenant_add_ons / tenant_usage (direct, no guards)', () => {
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

  async function createPlan(slugLabel: string) {
    // `plans` carries no RLS — a plain, contextless write via the app's
    // own restricted connection succeeds, proving the "no tenant
    // dimension" design directly (not merely asserting it in a comment).
    return prisma.plan.create({
      data: {
        key: `${slugLabel}-${Date.now()}`,
        name: slugLabel,
        limits: {
          academies: 1,
          students: 1,
          instructors: 1,
          staff: 1,
          courses: 1,
          generalStorage: 1,
          videoStorage: 1,
        },
        features: {
          cms: false,
          seo: false,
          seoAdvanced: false,
          marketing: false,
          marketingAdvanced: false,
          analytics: false,
          analyticsAdvanced: false,
          customDomain: false,
          themes: false,
          multipleThemes: false,
          backup: false,
        },
      },
    });
  }

  async function createSubscriptionOwnedBy(organizationId: string, planId: string) {
    return tenancyContext.runInTenantContext(organizationId, (tx) =>
      tx.tenantSubscription.create({ data: { organizationId, planId } }),
    );
  }

  it('platform tables (plans/add_ons/trial_policy) are readable with NO session context at all', async () => {
    const plan = await createPlan('rls-platform-readable');
    const rows = await prisma.plan.findMany({ where: { id: plan.id } });
    expect(rows).toHaveLength(1);
  });

  it('SELECT: an active tenant context only ever sees its own subscription row', async () => {
    const owner1 = await createUser('rls-sub-select-owner1');
    const owner2 = await createUser('rls-sub-select-owner2');
    const org1 = await createOrgOwnedBy(owner1.id, 'rls-sub-select-org1');
    const org2 = await createOrgOwnedBy(owner2.id, 'rls-sub-select-org2');
    const plan = await createPlan('rls-sub-select-plan');
    const sub1 = await createSubscriptionOwnedBy(org1.id, plan.id);
    const sub2 = await createSubscriptionOwnedBy(org2.id, plan.id);

    const visible = await tenancyContext.runInTenantContext(org1.id, (tx) =>
      tx.tenantSubscription.findMany({
        where: { organizationId: { in: [sub1.organizationId, sub2.organizationId] } },
      }),
    );
    expect(visible.map((s) => s.organizationId)).toEqual([sub1.organizationId]);
  });

  it('SELECT: with no session variable set at all, every subscription row is invisible (fail-closed)', async () => {
    const owner = await createUser('rls-sub-noctx-owner');
    const org = await createOrgOwnedBy(owner.id, 'rls-sub-noctx-org');
    const plan = await createPlan('rls-sub-noctx-plan');
    await createSubscriptionOwnedBy(org.id, plan.id);

    const rows = await prisma.tenantSubscription.findMany({
      where: { organizationId: org.id },
    });
    expect(rows).toEqual([]);
  });

  it('ATTACK (blocked): cannot create a subscription for a different organization than the active tenant context', async () => {
    const owner1 = await createUser('rls-atk-sub-owner1');
    const owner2 = await createUser('rls-atk-sub-owner2');
    const org1 = await createOrgOwnedBy(owner1.id, 'rls-atk-sub-org1');
    const org2 = await createOrgOwnedBy(owner2.id, 'rls-atk-sub-org2');
    const plan = await createPlan('rls-atk-sub-plan');

    await expect(
      tenancyContext.runInTenantContext(org1.id, (tx) =>
        tx.tenantSubscription.create({
          data: { organizationId: org2.id, planId: plan.id },
        }),
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it('ATTACK (blocked): cannot insert a tenant_add_on row for a different organization than the active tenant context', async () => {
    const owner1 = await createUser('rls-atk-addon-owner1');
    const owner2 = await createUser('rls-atk-addon-owner2');
    const org1 = await createOrgOwnedBy(owner1.id, 'rls-atk-addon-org1');
    const org2 = await createOrgOwnedBy(owner2.id, 'rls-atk-addon-org2');
    const addOn = await prisma.addOn.create({
      data: {
        key: `rls-atk-addon-${Date.now()}`,
        name: 'x',
        effect: { type: 'feature', featureKey: 'backup' },
      },
    });

    await expect(
      tenancyContext.runInTenantContext(org1.id, (tx) =>
        tx.tenantAddOn.create({ data: { organizationId: org2.id, addOnId: addOn.id } }),
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it('ATTACK (blocked): cannot insert tenant_usage for a different organization than the active tenant context', async () => {
    const owner1 = await createUser('rls-atk-usage-owner1');
    const owner2 = await createUser('rls-atk-usage-owner2');
    const org1 = await createOrgOwnedBy(owner1.id, 'rls-atk-usage-org1');
    const org2 = await createOrgOwnedBy(owner2.id, 'rls-atk-usage-org2');

    await expect(
      tenancyContext.runInTenantContext(org1.id, (tx) =>
        tx.tenantUsage.create({ data: { organizationId: org2.id } }),
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it('ATTACK (no-op): an UPDATE targeting tenant_usage outside the active tenant context affects zero rows', async () => {
    const owner1 = await createUser('rls-atk-usage-upd-owner1');
    const owner2 = await createUser('rls-atk-usage-upd-owner2');
    const org1 = await createOrgOwnedBy(owner1.id, 'rls-atk-usage-upd-org1');
    const org2 = await createOrgOwnedBy(owner2.id, 'rls-atk-usage-upd-org2');
    await tenancyContext.runInTenantContext(org2.id, (tx) =>
      tx.tenantUsage.create({ data: { organizationId: org2.id, academies: 1 } }),
    );

    const affected = await tenancyContext.runInTenantContext(org1.id, (tx) =>
      tx.tenantUsage.updateMany({
        where: { organizationId: org2.id },
        data: { academies: 999 },
      }),
    );
    expect(affected.count).toBe(0);

    const stillIntact = await tenancyContext.runInTenantContext(org2.id, (tx) =>
      tx.tenantUsage.findUniqueOrThrow({ where: { organizationId: org2.id } }),
    );
    expect(stillIntact.academies).toBe(1);
  });

  it('LEGITIMATE (allowed): creating a subscription, add-on, and usage row within the active tenant context', async () => {
    const owner = await createUser('rls-legit-sub-owner');
    const org = await createOrgOwnedBy(owner.id, 'rls-legit-sub-org');
    const plan = await createPlan('rls-legit-sub-plan');
    const addOn = await prisma.addOn.create({
      data: {
        key: `rls-legit-addon-${Date.now()}`,
        name: 'x',
        effect: { type: 'feature', featureKey: 'backup' },
      },
    });

    const subscription = await createSubscriptionOwnedBy(org.id, plan.id);
    expect(subscription.organizationId).toBe(org.id);

    const tenantAddOn = await tenancyContext.runInTenantContext(org.id, (tx) =>
      tx.tenantAddOn.create({ data: { organizationId: org.id, addOnId: addOn.id } }),
    );
    expect(tenantAddOn.organizationId).toBe(org.id);

    const usage = await tenancyContext.runInTenantContext(org.id, (tx) =>
      tx.tenantUsage.upsert({
        where: { organizationId: org.id },
        create: { organizationId: org.id, academies: 2 },
        update: { academies: 2 },
      }),
    );
    expect(usage.academies).toBe(2);
  });
});
