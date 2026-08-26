/**
 * Direct PostgreSQL/RLS proof for `organization_payment_settings` /
 * `organization_gateway_credentials` / `organization_connected_accounts` /
 * `organization_commission_settings` / `atlas_commission_config` (master
 * plan §4.1/§4.2/§5.8, §7, §16) — mirrors `rls-billing.e2e-spec.ts`'s exact
 * pattern: every test talks to Postgres directly through the app's own
 * `PrismaService` (connected as the restricted `atlas_app` role) and
 * `TenancyContextService`. No guard, no service, no HTTP request anywhere
 * in this file.
 *
 * The one genuinely novel RLS shape this phase introduces —
 * `organization_commission_settings`'s asymmetric read/write policies (§4.2:
 * "an Organization must not be able to grant itself a commission exemption
 * or modify its own rate") — is the focus of this file's most important
 * test, proved at the database level, not merely by a controller lacking a
 * route.
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { PrismaService } from '../src/database/prisma.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';

describe('Row-Level Security — organization payment configuration (direct, no guards)', () => {
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

  async function createUser(
    label: string,
    isPlatformOwner = false,
  ): Promise<{ id: string }> {
    const user = await prisma.user.create({
      data: {
        email: uniqueTestEmail(label),
        passwordHash: 'x',
        name: label,
        isPlatformOwner,
      },
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

  describe('organization_payment_settings', () => {
    it('SELECT: an active tenant context only ever sees its own row', async () => {
      const owner1 = await createUser('rls-ops-select-owner1');
      const owner2 = await createUser('rls-ops-select-owner2');
      const org1 = await createOrgOwnedBy(owner1.id, 'rls-ops-select-org1');
      const org2 = await createOrgOwnedBy(owner2.id, 'rls-ops-select-org2');
      await tenancyContext.runInTenantContext(org1.id, (tx) =>
        tx.organizationPaymentSettings.create({
          data: { organizationId: org1.id, paymentCollectionMode: 'atlas_payments' },
        }),
      );
      await tenancyContext.runInTenantContext(org2.id, (tx) =>
        tx.organizationPaymentSettings.create({
          data: {
            organizationId: org2.id,
            paymentCollectionMode: 'organization_gateway',
          },
        }),
      );

      const visible = await tenancyContext.runInTenantContext(org1.id, (tx) =>
        tx.organizationPaymentSettings.findMany({
          where: { organizationId: { in: [org1.id, org2.id] } },
        }),
      );
      expect(visible.map((r) => r.organizationId)).toEqual([org1.id]);
    });

    it('SELECT: with no session variable set at all, every row is invisible (fail-closed)', async () => {
      const owner = await createUser('rls-ops-noctx-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-ops-noctx-org');
      await tenancyContext.runInTenantContext(org.id, (tx) =>
        tx.organizationPaymentSettings.create({
          data: { organizationId: org.id, paymentCollectionMode: 'atlas_payments' },
        }),
      );

      const rows = await prisma.organizationPaymentSettings.findMany({
        where: { organizationId: org.id },
      });
      expect(rows).toEqual([]);
    });

    it('ATTACK (blocked): cannot create a row for a different organization than the active tenant context', async () => {
      const owner1 = await createUser('rls-atk-ops-owner1');
      const owner2 = await createUser('rls-atk-ops-owner2');
      const org1 = await createOrgOwnedBy(owner1.id, 'rls-atk-ops-org1');
      const org2 = await createOrgOwnedBy(owner2.id, 'rls-atk-ops-org2');

      await expect(
        tenancyContext.runInTenantContext(org1.id, (tx) =>
          tx.organizationPaymentSettings.create({
            data: { organizationId: org2.id, paymentCollectionMode: 'atlas_payments' },
          }),
        ),
      ).rejects.toThrow(/row-level security policy/i);
    });
  });

  describe('organization_gateway_credentials / organization_connected_accounts — tenant isolation matches organization_payment_settings', () => {
    it('gateway credentials: an active tenant context only ever sees its own row', async () => {
      const owner1 = await createUser('rls-ogc-owner1');
      const owner2 = await createUser('rls-ogc-owner2');
      const org1 = await createOrgOwnedBy(owner1.id, 'rls-ogc-org1');
      const org2 = await createOrgOwnedBy(owner2.id, 'rls-ogc-org2');
      await tenancyContext.runInTenantContext(org1.id, (tx) =>
        tx.organizationGatewayCredential.create({
          data: {
            organizationId: org1.id,
            providerKey: 'placeholder',
            encryptedConfig: 'x',
          },
        }),
      );

      const visibleFromOrg2 = await tenancyContext.runInTenantContext(org2.id, (tx) =>
        tx.organizationGatewayCredential.findMany({ where: { organizationId: org1.id } }),
      );
      expect(visibleFromOrg2).toEqual([]);
    });

    it('connected accounts: an active tenant context only ever sees its own row', async () => {
      const owner1 = await createUser('rls-oca-owner1');
      const owner2 = await createUser('rls-oca-owner2');
      const org1 = await createOrgOwnedBy(owner1.id, 'rls-oca-org1');
      const org2 = await createOrgOwnedBy(owner2.id, 'rls-oca-org2');
      await tenancyContext.runInTenantContext(org1.id, (tx) =>
        tx.organizationConnectedAccount.create({ data: { organizationId: org1.id } }),
      );

      const visibleFromOrg2 = await tenancyContext.runInTenantContext(org2.id, (tx) =>
        tx.organizationConnectedAccount.findMany({ where: { organizationId: org1.id } }),
      );
      expect(visibleFromOrg2).toEqual([]);
    });
  });

  describe('organization_commission_settings — asymmetric read/write (§4.2)', () => {
    it("SELECT: the owning Organization's own tenant context can read its own row", async () => {
      const platformOwner = await createUser('rls-ocs-platform-select', true);
      const owner = await createUser('rls-ocs-tenant-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-ocs-tenant-org');
      await tenancyContext.runInUserContext(platformOwner.id, (tx) =>
        tx.organizationCommissionSettings.create({
          data: {
            organizationId: org.id,
            commissionMode: 'custom',
            customPercentageBasisPoints: 777,
            updatedBy: platformOwner.id,
          },
        }),
      );

      const visible = await tenancyContext.runInTenantContext(org.id, (tx) =>
        tx.organizationCommissionSettings.findUnique({
          where: { organizationId: org.id },
        }),
      );
      expect(visible?.commissionMode).toBe('custom');
      expect(visible?.customPercentageBasisPoints).toBe(777);
    });

    it('ATTACK (blocked): the owning Organization itself cannot INSERT its own commission row — no tenant INSERT policy exists at all', async () => {
      const owner = await createUser('rls-atk-ocs-insert-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-atk-ocs-insert-org');

      await expect(
        tenancyContext.runInTenantContext(org.id, (tx) =>
          tx.organizationCommissionSettings.create({
            data: { organizationId: org.id, commissionMode: 'exempt' },
          }),
        ),
      ).rejects.toThrow(/row-level security policy/i);
    });

    it('ATTACK (blocked): the owning Organization cannot UPDATE its own commission row to grant itself an exemption — even a row a Platform Owner already created', async () => {
      const platformOwner = await createUser('rls-atk-ocs-update-platform', true);
      const owner = await createUser('rls-atk-ocs-update-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-atk-ocs-update-org');
      await tenancyContext.runInUserContext(platformOwner.id, (tx) =>
        tx.organizationCommissionSettings.create({
          data: { organizationId: org.id, commissionMode: 'default' },
        }),
      );

      // A tenant-context UPDATE affects zero rows (the USING clause hides
      // the row from the tenant role entirely for UPDATE too) rather than
      // throwing — Postgres RLS's own documented behavior for an UPDATE
      // whose USING policy matches nothing. The concrete proof is that the
      // value never actually changes.
      await tenancyContext.runInTenantContext(org.id, (tx) =>
        tx.organizationCommissionSettings.updateMany({
          where: { organizationId: org.id },
          data: { commissionMode: 'exempt' },
        }),
      );

      const stillDefault = await tenancyContext.runInUserContext(platformOwner.id, (tx) =>
        tx.organizationCommissionSettings.findUnique({
          where: { organizationId: org.id },
        }),
      );
      expect(stillDefault?.commissionMode).toBe('default');
    });

    it("a Platform Owner context can INSERT and UPDATE any organization's commission row", async () => {
      const platformOwner = await createUser('rls-ocs-platform-write', true);
      const owner = await createUser('rls-ocs-platform-write-org-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-ocs-platform-write-org');

      await tenancyContext.runInUserContext(platformOwner.id, (tx) =>
        tx.organizationCommissionSettings.create({
          data: { organizationId: org.id, commissionMode: 'default' },
        }),
      );
      await tenancyContext.runInUserContext(platformOwner.id, (tx) =>
        tx.organizationCommissionSettings.update({
          where: { organizationId: org.id },
          data: { commissionMode: 'exempt' },
        }),
      );

      const updated = await tenancyContext.runInUserContext(platformOwner.id, (tx) =>
        tx.organizationCommissionSettings.findUnique({
          where: { organizationId: org.id },
        }),
      );
      expect(updated?.commissionMode).toBe('exempt');
    });

    it('a non-platform-owner user context cannot INSERT a commission row for any organization via runInUserContext either', async () => {
      const nonOwner = await createUser('rls-atk-ocs-nonowner', false);
      const owner = await createUser('rls-atk-ocs-nonowner-org-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-atk-ocs-nonowner-org');

      await expect(
        tenancyContext.runInUserContext(nonOwner.id, (tx) =>
          tx.organizationCommissionSettings.create({
            data: { organizationId: org.id, commissionMode: 'exempt' },
          }),
        ),
      ).rejects.toThrow(/row-level security policy/i);
    });
  });

  describe('atlas_commission_config — platform-owned singleton, no RLS', () => {
    it('is readable and writable with NO session context at all — mirrors platform_domain_configuration/trial_policy', async () => {
      const before = await prisma.atlasCommissionConfig.findMany({});
      const row = await prisma.atlasCommissionConfig.upsert({
        where: { id: '00000000-0000-0000-0000-0000000000c1' },
        create: {
          id: '00000000-0000-0000-0000-0000000000c1',
          defaultCommissionBasisPoints: 1234,
        },
        update: { defaultCommissionBasisPoints: 1234 },
      });
      expect(row.defaultCommissionBasisPoints).toBe(1234);
      void before;
    });
  });
});
