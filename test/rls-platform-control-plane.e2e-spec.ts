/**
 * Direct PostgreSQL/RLS proof for Phase P15's new `_platform_select`
 * policies on existing tenant tables, plus the three new tables
 * (`audit_log_entries`/`support_cases`/`support_case_messages`) — mirrors
 * `rls-provisioning.e2e-spec.ts`'s exact pattern: every test talks to
 * Postgres directly through the app's own `PrismaService` (connected as
 * the restricted `atlas_app` role) and `TenancyContextService`. No guard,
 * no service, no HTTP request anywhere in this file.
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import { PrismaService } from '../src/database/prisma.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import type { PrismaClient } from '@prisma/client';

describe('Row-Level Security — Platform Owner Control Plane (direct, no guards)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenancyContext: TenancyContextService;
  let admin: PrismaClient;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    prisma = testApp.prisma;
    tenancyContext = app.get(TenancyContextService, { strict: false });
    admin = createAdminPrisma();
  });

  afterAll(async () => {
    await admin.$disconnect();
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

  async function createAcademy(organizationId: string, slugLabel: string) {
    return tenancyContext.runInTenantContext(organizationId, (tx) =>
      tx.academy.create({
        data: { organizationId, name: slugLabel, slug: `${slugLabel}-${Date.now()}` },
      }),
    );
  }

  describe('_platform_select policies on existing tenant tables', () => {
    it('organizations: a Platform Owner user context sees an organization no tenant context was set for', async () => {
      const owner = await createUser('rls-plat-org-owner');
      const platformOwner = await createUser('rls-plat-org-po', true);
      const org = await createOrgOwnedBy(owner.id, 'rls-plat-org');

      const visible = await tenancyContext.runInUserContext(platformOwner.id, (tx) =>
        tx.organization.findMany({ where: { id: org.id } }),
      );
      expect(visible.map((o) => o.id)).toEqual([org.id]);

      const notPlatformOwner = await createUser('rls-plat-org-nonpo', false);
      const invisible = await tenancyContext.runInUserContext(notPlatformOwner.id, (tx) =>
        tx.organization.findMany({ where: { id: org.id } }),
      );
      expect(invisible).toHaveLength(0);
    });

    it('academies: a Platform Owner user context sees an academy across organizations', async () => {
      const owner = await createUser('rls-plat-academy-owner');
      const platformOwner = await createUser('rls-plat-academy-po', true);
      const org = await createOrgOwnedBy(owner.id, 'rls-plat-academy-org');
      const academy = await createAcademy(org.id, 'rls-plat-academy');

      const visible = await tenancyContext.runInUserContext(platformOwner.id, (tx) =>
        tx.academy.findMany({ where: { id: academy.id } }),
      );
      expect(visible.map((a) => a.id)).toEqual([academy.id]);
    });

    it('organization_memberships: a Platform Owner user context sees memberships across organizations', async () => {
      const owner = await createUser('rls-plat-membership-owner');
      const platformOwner = await createUser('rls-plat-membership-po', true);
      const org = await createOrgOwnedBy(owner.id, 'rls-plat-membership-org');

      const visible = await tenancyContext.runInUserContext(platformOwner.id, (tx) =>
        tx.organizationMembership.findMany({ where: { organizationId: org.id } }),
      );
      expect(visible).toHaveLength(1);
      expect(visible[0].userId).toBe(owner.id);
    });

    it('a non-Platform-Owner user context still cannot see cross-tenant academies or memberships (fail-closed)', async () => {
      const owner = await createUser('rls-plat-fail-owner');
      const notPlatformOwner = await createUser('rls-plat-fail-nonpo', false);
      const org = await createOrgOwnedBy(owner.id, 'rls-plat-fail-org');
      const academy = await createAcademy(org.id, 'rls-plat-fail-academy');

      const visibleAcademies = await tenancyContext.runInUserContext(
        notPlatformOwner.id,
        (tx) => tx.academy.findMany({ where: { id: academy.id } }),
      );
      expect(visibleAcademies).toHaveLength(0);

      const visibleMemberships = await tenancyContext.runInUserContext(
        notPlatformOwner.id,
        (tx) => tx.organizationMembership.findMany({ where: { organizationId: org.id } }),
      );
      expect(visibleMemberships).toHaveLength(0);
    });
  });

  describe('audit_log_entries', () => {
    it('SELECT: a Platform Owner user context sees audit entries; a non-Platform-Owner sees none', async () => {
      const owner = await createUser('rls-audit-owner');
      const platformOwner = await createUser('rls-audit-po', true);
      const notPlatformOwner = await createUser('rls-audit-nonpo', false);
      const org = await createOrgOwnedBy(owner.id, 'rls-audit-org');

      // INSERT under a plain tenant context (no `app.current_user_id` set
      // at all) — proves the deliberately permissive `WITH CHECK (true)`
      // insert policy works from a context with no platform-owner
      // session variable, exactly like the real `AcademiesService.create`
      // call path this policy exists for.
      const entryId = await tenancyContext.runInTenantContext(org.id, async (tx) => {
        const id = randomUUID();
        await tx.$executeRaw`
          INSERT INTO "audit_log_entries" ("id", "actor_user_id", "organization_id", "action", "target_type", "target_id")
          VALUES (${id}, ${owner.id}, ${org.id}, 'rls_test.created', 'test_target', ${id})
        `;
        return id;
      });

      const visible = await tenancyContext.runInUserContext(platformOwner.id, (tx) =>
        tx.auditLogEntry.findMany({ where: { id: entryId } }),
      );
      expect(visible.map((e) => e.id)).toEqual([entryId]);

      const invisible = await tenancyContext.runInUserContext(notPlatformOwner.id, (tx) =>
        tx.auditLogEntry.findMany({ where: { id: entryId } }),
      );
      expect(invisible).toHaveLength(0);

      const noContext = await prisma.auditLogEntry.findMany({ where: { id: entryId } });
      expect(noContext).toHaveLength(0);
    });

    it('UPDATE/DELETE: no policy permits either — the table is genuinely append-only for atlas_app', async () => {
      const owner = await createUser('rls-audit-immutable-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-audit-immutable-org');
      const entryId = await tenancyContext.runInTenantContext(org.id, async (tx) => {
        const id = randomUUID();
        await tx.$executeRaw`
          INSERT INTO "audit_log_entries" ("id", "actor_user_id", "organization_id", "action", "target_type", "target_id")
          VALUES (${id}, ${owner.id}, ${org.id}, 'rls_test.immutable', 'test_target', ${id})
        `;
        return id;
      });

      const platformOwner = await createUser('rls-audit-immutable-po', true);
      await expect(
        tenancyContext.runInUserContext(platformOwner.id, (tx) =>
          tx.auditLogEntry.update({
            where: { id: entryId },
            data: { action: 'tampered' },
          }),
        ),
      ).rejects.toThrow();
      await expect(
        tenancyContext.runInUserContext(platformOwner.id, (tx) =>
          tx.auditLogEntry.delete({ where: { id: entryId } }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('support_cases / support_case_messages', () => {
    // Seeded via the admin (superuser, RLS-bypassing) connection — there
    // is deliberately no INSERT policy on `support_cases` for `atlas_app`
    // at all (see the P15 migration's own doc comment: no create-case
    // endpoint exists in this phase), matching `db-admin.ts`'s own
    // "elevated connection for fixture arrangement only" precedent.
    async function createSupportCase() {
      return admin.supportCase.create({
        data: {
          subject: `rls-support-${Date.now()}`,
          requesterName: 'rls-support',
          requesterEmail: uniqueTestEmail('rls-support'),
        },
      });
    }

    it('SELECT: a Platform Owner user context sees support cases; a non-Platform-Owner and no-context both see none', async () => {
      const platformOwner = await createUser('rls-support-po', true);
      const notPlatformOwner = await createUser('rls-support-nonpo', false);
      const supportCase = await createSupportCase();

      const visible = await tenancyContext.runInUserContext(platformOwner.id, (tx) =>
        tx.supportCase.findMany({ where: { id: supportCase.id } }),
      );
      expect(visible.map((c) => c.id)).toEqual([supportCase.id]);

      const invisible = await tenancyContext.runInUserContext(notPlatformOwner.id, (tx) =>
        tx.supportCase.findMany({ where: { id: supportCase.id } }),
      );
      expect(invisible).toHaveLength(0);

      const noContext = await prisma.supportCase.findMany({
        where: { id: supportCase.id },
      });
      expect(noContext).toHaveLength(0);
    });

    it('INSERT: no policy permits a plain atlas_app insert — there is deliberately no create-case endpoint in this phase', async () => {
      const platformOwner = await createUser('rls-support-noinsert-po', true);
      await expect(
        tenancyContext.runInUserContext(platformOwner.id, (tx) =>
          tx.supportCase.create({
            data: {
              subject: 'should be rejected',
              requesterName: 'nobody',
              requesterEmail: uniqueTestEmail('rls-support-noinsert'),
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it('UPDATE: a Platform Owner user context can update status; a non-Platform-Owner cannot', async () => {
      const platformOwner = await createUser('rls-support-update-po', true);
      const notPlatformOwner = await createUser('rls-support-update-nonpo', false);
      const supportCase = await createSupportCase();

      const updated = await tenancyContext.runInUserContext(platformOwner.id, (tx) =>
        tx.supportCase.update({
          where: { id: supportCase.id },
          data: { status: 'closed' },
        }),
      );
      expect(updated.status).toBe('closed');

      await expect(
        tenancyContext.runInUserContext(notPlatformOwner.id, (tx) =>
          tx.supportCase.update({
            where: { id: supportCase.id },
            data: { status: 'open' },
          }),
        ),
      ).rejects.toThrow();
    });

    it('support_case_messages: a Platform Owner can insert/select; a non-Platform-Owner sees nothing', async () => {
      const platformOwner = await createUser('rls-support-msg-po', true);
      const notPlatformOwner = await createUser('rls-support-msg-nonpo', false);
      const supportCase = await createSupportCase();

      const message = await tenancyContext.runInUserContext(platformOwner.id, (tx) =>
        tx.supportCaseMessage.create({
          data: {
            caseId: supportCase.id,
            authorName: 'Agent',
            authorRole: 'agent',
            body: 'rls test reply',
          },
        }),
      );
      expect(message.caseId).toBe(supportCase.id);

      const visible = await tenancyContext.runInUserContext(platformOwner.id, (tx) =>
        tx.supportCaseMessage.findMany({ where: { caseId: supportCase.id } }),
      );
      expect(visible).toHaveLength(1);

      const invisible = await tenancyContext.runInUserContext(notPlatformOwner.id, (tx) =>
        tx.supportCaseMessage.findMany({ where: { caseId: supportCase.id } }),
      );
      expect(invisible).toHaveLength(0);
    });
  });
});
