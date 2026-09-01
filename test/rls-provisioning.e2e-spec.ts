/**
 * Direct PostgreSQL/RLS proof for Phase P14's new tables
 * (`provisioning_requests`/`provisioning_steps`) plus the new
 * `subdomain_is_taken` SECURITY DEFINER function — mirrors
 * `rls-course-commerce.e2e-spec.ts`'s exact pattern: every test talks to
 * Postgres directly through the app's own `PrismaService` (connected as
 * the restricted `atlas_app` role) and `TenancyContextService`. No guard,
 * no service, no HTTP request anywhere in this file.
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { PrismaService } from '../src/database/prisma.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';

describe('Row-Level Security — Provisioning (provisioning_requests/provisioning_steps, direct, no guards)', () => {
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

  async function createUser(label: string, isPlatformOwner = false) {
    return prisma.user.create({
      data: {
        email: uniqueTestEmail(label),
        passwordHash: 'x',
        name: label,
        isPlatformOwner,
      },
    });
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

  async function createProvisioningRequest(
    organizationId: string,
    requestedByUserId: string,
    slugLabel: string,
  ) {
    return tenancyContext.runInTenantContext(organizationId, (tx) =>
      tx.provisioningRequest.create({
        data: {
          organizationId,
          requestedByUserId,
          requestedAcademyName: slugLabel,
          requestedSubdomain: `${slugLabel}-${Date.now()}`.slice(0, 50),
          idempotencyKey: `rls-pr-${randomUUID()}`,
        },
      }),
    );
  }

  async function createSteps(organizationId: string, provisioningRequestId: string) {
    return tenancyContext.runInTenantContext(organizationId, (tx) =>
      tx.provisioningStep.createMany({
        data: (
          [
            'tenant',
            'academy',
            'theme',
            'branding',
            'subdomain',
            'domain',
            'finalization',
          ] as const
        ).map((key) => ({ provisioningRequestId, key })),
      }),
    );
  }

  describe('provisioning_requests', () => {
    it("SELECT: a tenant context only ever sees its own organization's provisioning requests", async () => {
      const owner1 = await createUser('rls-pr-owner1');
      const owner2 = await createUser('rls-pr-owner2');
      const org1 = await createOrgOwnedBy(owner1.id, 'rls-pr-org1');
      const org2 = await createOrgOwnedBy(owner2.id, 'rls-pr-org2');
      const request1 = await createProvisioningRequest(org1.id, owner1.id, 'rls-pr-req1');
      const request2 = await createProvisioningRequest(org2.id, owner2.id, 'rls-pr-req2');

      const visible = await tenancyContext.runInTenantContext(org1.id, (tx) =>
        tx.provisioningRequest.findMany({
          where: { id: { in: [request1.id, request2.id] } },
        }),
      );
      expect(visible.map((r) => r.id)).toEqual([request1.id]);
    });

    it('SELECT: with no session variable set at all, every provisioning request is invisible (fail-closed)', async () => {
      const owner = await createUser('rls-pr-noctx-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-pr-noctx-org');
      const req = await createProvisioningRequest(org.id, owner.id, 'rls-pr-noctx-req');

      const visible = await prisma.provisioningRequest.findMany({
        where: { id: req.id },
      });
      expect(visible).toHaveLength(0);
    });

    it('SELECT: a Platform Owner user context sees provisioning requests across every organization', async () => {
      const owner = await createUser('rls-pr-plat-owner');
      const platformOwner = await createUser('rls-pr-plat-reviewer', true);
      const org = await createOrgOwnedBy(owner.id, 'rls-pr-plat-org');
      const req = await createProvisioningRequest(org.id, owner.id, 'rls-pr-plat-req');

      const visible = await tenancyContext.runInUserContext(platformOwner.id, (tx) =>
        tx.provisioningRequest.findMany({ where: { id: req.id } }),
      );
      expect(visible.map((r) => r.id)).toEqual([req.id]);
    });

    it('SELECT: a non-Platform-Owner user context (no organization context) sees nothing', async () => {
      const owner = await createUser('rls-pr-notplat-owner');
      const notPlatformOwner = await createUser('rls-pr-notplat-reviewer', false);
      const org = await createOrgOwnedBy(owner.id, 'rls-pr-notplat-org');
      const req = await createProvisioningRequest(org.id, owner.id, 'rls-pr-notplat-req');

      const visible = await tenancyContext.runInUserContext(notPlatformOwner.id, (tx) =>
        tx.provisioningRequest.findMany({ where: { id: req.id } }),
      );
      expect(visible).toHaveLength(0);
    });

    it('INSERT: a tenant context can insert into its own organization only', async () => {
      const owner = await createUser('rls-pr-insert-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-pr-insert-org');
      const created = await createProvisioningRequest(
        org.id,
        owner.id,
        'rls-pr-insert-req',
      );
      expect(created.organizationId).toBe(org.id);
    });

    it('INSERT: inserting under a mismatched organization context is rejected by RLS', async () => {
      const owner1 = await createUser('rls-pr-badinsert-owner1');
      const owner2 = await createUser('rls-pr-badinsert-owner2');
      const org1 = await createOrgOwnedBy(owner1.id, 'rls-pr-badinsert-org1');
      const org2 = await createOrgOwnedBy(owner2.id, 'rls-pr-badinsert-org2');

      await expect(
        tenancyContext.runInTenantContext(org1.id, (tx) =>
          tx.provisioningRequest.create({
            data: {
              organizationId: org2.id,
              requestedByUserId: owner2.id,
              requestedAcademyName: 'mismatched',
              requestedSubdomain: `rls-pr-badinsert-${Date.now()}`,
              idempotencyKey: `rls-pr-badinsert-${randomUUID()}`,
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it("UPDATE: a tenant context can update its own organization's request", async () => {
      const owner = await createUser('rls-pr-update-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-pr-update-org');
      const req = await createProvisioningRequest(org.id, owner.id, 'rls-pr-update-req');

      const updated = await tenancyContext.runInTenantContext(org.id, (tx) =>
        tx.provisioningRequest.update({
          where: { id: req.id },
          data: { status: 'cancelled' },
        }),
      );
      expect(updated.status).toBe('cancelled');
    });

    it("UPDATE: a different organization's tenant context cannot update this request (RLS-invisible, no row matched)", async () => {
      const owner1 = await createUser('rls-pr-crossupdate-owner1');
      const owner2 = await createUser('rls-pr-crossupdate-owner2');
      const org1 = await createOrgOwnedBy(owner1.id, 'rls-pr-crossupdate-org1');
      const org2 = await createOrgOwnedBy(owner2.id, 'rls-pr-crossupdate-org2');
      const req1 = await createProvisioningRequest(
        org1.id,
        owner1.id,
        'rls-pr-crossupdate-req1',
      );

      await expect(
        tenancyContext.runInTenantContext(org2.id, (tx) =>
          tx.provisioningRequest.update({
            where: { id: req1.id },
            data: { status: 'cancelled' },
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('provisioning_steps (transitive via provisioning_requests.organization_id)', () => {
    it("SELECT: a tenant context only ever sees steps belonging to its own organization's requests", async () => {
      const owner1 = await createUser('rls-ps-owner1');
      const owner2 = await createUser('rls-ps-owner2');
      const org1 = await createOrgOwnedBy(owner1.id, 'rls-ps-org1');
      const org2 = await createOrgOwnedBy(owner2.id, 'rls-ps-org2');
      const req1 = await createProvisioningRequest(org1.id, owner1.id, 'rls-ps-req1');
      const req2 = await createProvisioningRequest(org2.id, owner2.id, 'rls-ps-req2');
      await createSteps(org1.id, req1.id);
      await createSteps(org2.id, req2.id);

      const visible = await tenancyContext.runInTenantContext(org1.id, (tx) =>
        tx.provisioningStep.findMany({
          where: { provisioningRequestId: { in: [req1.id, req2.id] } },
        }),
      );
      expect(visible).toHaveLength(7);
      expect(visible.every((s) => s.provisioningRequestId === req1.id)).toBe(true);
    });

    it("SELECT: a Platform Owner user context sees steps across every organization's requests", async () => {
      const owner = await createUser('rls-ps-plat-owner');
      const platformOwner = await createUser('rls-ps-plat-reviewer', true);
      const org = await createOrgOwnedBy(owner.id, 'rls-ps-plat-org');
      const req = await createProvisioningRequest(org.id, owner.id, 'rls-ps-plat-req');
      await createSteps(org.id, req.id);

      const visible = await tenancyContext.runInUserContext(platformOwner.id, (tx) =>
        tx.provisioningStep.findMany({ where: { provisioningRequestId: req.id } }),
      );
      expect(visible).toHaveLength(7);
    });

    it('SELECT: with no session variable set at all, every step is invisible (fail-closed)', async () => {
      const owner = await createUser('rls-ps-noctx-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-ps-noctx-org');
      const req = await createProvisioningRequest(org.id, owner.id, 'rls-ps-noctx-req');
      await createSteps(org.id, req.id);

      const visible = await prisma.provisioningStep.findMany({
        where: { provisioningRequestId: req.id },
      });
      expect(visible).toHaveLength(0);
    });

    it("UPDATE: a tenant context can update a step belonging to its own organization's request", async () => {
      const owner = await createUser('rls-ps-update-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-ps-update-org');
      const req = await createProvisioningRequest(org.id, owner.id, 'rls-ps-update-req');
      await createSteps(org.id, req.id);

      const updated = await tenancyContext.runInTenantContext(org.id, (tx) =>
        tx.provisioningStep.update({
          where: {
            provisioningRequestId_key: { provisioningRequestId: req.id, key: 'tenant' },
          },
          data: { status: 'completed' },
        }),
      );
      expect(updated.status).toBe('completed');
    });

    it("UPDATE: a different organization's tenant context cannot update another organization's step", async () => {
      const owner1 = await createUser('rls-ps-crossupdate-owner1');
      const owner2 = await createUser('rls-ps-crossupdate-owner2');
      const org1 = await createOrgOwnedBy(owner1.id, 'rls-ps-crossupdate-org1');
      const org2 = await createOrgOwnedBy(owner2.id, 'rls-ps-crossupdate-org2');
      const req1 = await createProvisioningRequest(
        org1.id,
        owner1.id,
        'rls-ps-crossupdate-req1',
      );
      await createSteps(org1.id, req1.id);

      await expect(
        tenancyContext.runInTenantContext(org2.id, (tx) =>
          tx.provisioningStep.update({
            where: {
              provisioningRequestId_key: {
                provisioningRequestId: req1.id,
                key: 'tenant',
              },
            },
            data: { status: 'completed' },
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('subdomain_is_taken() — SECURITY DEFINER, context-free', () => {
    it("reports false for a never-allocated subdomain, and true once one exists, regardless of the caller's own tenant context", async () => {
      const owner = await createUser('rls-sit-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-sit-org');
      const academy = await tenancyContext.runInTenantContext(org.id, (tx) =>
        tx.academy.create({
          data: {
            organizationId: org.id,
            name: 'rls-sit',
            slug: `rls-sit-${Date.now()}`,
          },
        }),
      );
      // Phase 1 (Extended Scope, dependency A) — reproduces the real
      // `AcademiesService.create`'s auto-granted owner membership, which
      // the new `is_academy_member`-gated `subdomain_allocations` policies
      // now require.
      await tenancyContext.runInTenantContext(org.id, (tx) =>
        tx.academyMember.create({
          data: {
            academyId: academy.id,
            userId: owner.id,
            role: 'owner',
            status: 'active',
          },
        }),
      );
      const subdomain = `rls-sit-check-${Date.now()}`;

      const before = await prisma.$queryRaw<{ subdomain_is_taken: boolean }[]>`
        SELECT subdomain_is_taken(${subdomain}) AS subdomain_is_taken
      `;
      expect(before[0]?.subdomain_is_taken).toBe(false);

      await tenancyContext.runInTenantAndUserContext(org.id, owner.id, (tx) =>
        tx.subdomainAllocation.create({
          data: { academyId: academy.id, subdomain, status: 'assigned' },
        }),
      );

      // No tenant/user context set at all — proves this is genuinely
      // SECURITY DEFINER and context-free, not accidentally piggybacking
      // on `subdomain_allocations`' own RLS policy.
      const after = await prisma.$queryRaw<{ subdomain_is_taken: boolean }[]>`
        SELECT subdomain_is_taken(${subdomain}) AS subdomain_is_taken
      `;
      expect(after[0]?.subdomain_is_taken).toBe(true);
    });
  });
});
