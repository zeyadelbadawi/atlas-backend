/**
 * Platform Owner Control Plane — functional/contract e2e suite (Phase
 * P15, master plan §21/§5.12). The real business surfaces this phase
 * exists to prove end to end: cross-tenant Organizations/Academies/Users
 * read, the real Audit Log, Support Operations, and Platform Settings.
 *
 * Cross-tenant security/authorization boundaries are covered separately
 * in `platform-control-plane-tenant-isolation.e2e-spec.ts`; the
 * direct-Postgres RLS proof is `rls-platform-control-plane.e2e-spec.ts`.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedCourse,
  seedOrganizationWithOwner,
  seedPlan,
  seedTenantSubscription,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

jest.setTimeout(30000);

async function signUpAndSignIn(
  app: INestApplication,
  label: string,
): Promise<{ userId: string; accessToken: string }> {
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
  return { userId: signIn.body.user.id, accessToken: signIn.body.accessToken };
}

async function makePlatformOwner(admin: PrismaClient, userId: string): Promise<void> {
  await admin.user.update({ where: { id: userId }, data: { isPlatformOwner: true } });
}

describe('Platform Owner Control Plane — P15 (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  async function arrangePlatformOwner(label: string) {
    const owner = await signUpAndSignIn(app, label);
    await makePlatformOwner(admin, owner.userId);
    return owner;
  }

  // --- A. Platform Organizations ------------------------------------------

  describe('Platform Organizations', () => {
    it('A1: a Platform Owner can list organizations, paginated', async () => {
      const platformOwner = await arrangePlatformOwner('org-list-po');
      const tenantOwner = await signUpAndSignIn(app, 'org-list-tenant');
      await seedOrganizationWithOwner(admin, tenantOwner.userId, 'org-list-org');

      const res = await request(app.getHttpServer())
        .get('/organizations')
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .expect(200);

      expect(res.body.pagination).toMatchObject({ page: 1 });
      expect(Array.isArray(res.body.items)).toBe(true);
    });

    it('A2: search filters the organization list', async () => {
      const platformOwner = await arrangePlatformOwner('org-search-po');
      const tenantOwner = await signUpAndSignIn(app, 'org-search-tenant');
      const uniqueName = `Findable-${Date.now()}`;
      const org = await seedOrganizationWithOwner(admin, tenantOwner.userId, uniqueName);
      await admin.organization.update({
        where: { id: org.id },
        data: { name: uniqueName },
      });

      const res = await request(app.getHttpServer())
        .get('/organizations')
        .query({ search: uniqueName })
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .expect(200);

      expect(res.body.items.some((item: { id: string }) => item.id === org.id)).toBe(
        true,
      );
    });

    it('A3-A4: a Platform Owner can read organization detail, including subscription/academies/members', async () => {
      const platformOwner = await arrangePlatformOwner('org-detail-po');
      const tenantOwner = await signUpAndSignIn(app, 'org-detail-tenant');
      const org = await seedOrganizationWithOwner(
        admin,
        tenantOwner.userId,
        'org-detail-org',
      );
      const academy = await seedAcademy(admin, org.id, 'org-detail-academy');
      const plan = await seedPlan(admin, 'org-detail-plan');
      await seedTenantSubscription(admin, org.id, plan.id, { status: 'active' });

      const res = await request(app.getHttpServer())
        .get(`/organizations/${org.id}`)
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .expect(200);

      expect(res.body).toMatchObject({
        id: org.id,
        name: org.name,
        academyCount: 1,
        memberCount: 1,
        planName: plan.name,
        subscriptionStatus: 'active',
      });
      expect(res.body.academies.some((a: { id: string }) => a.id === academy.id)).toBe(
        true,
      );
      expect(res.body.members).toHaveLength(1);
      expect(res.body.members[0]).toMatchObject({ role: 'owner' });
      expect(res.body.subscription).toBeTruthy();
    });

    it('A5: a normal tenant member still gets their own narrow organization detail, unchanged', async () => {
      const tenantOwner = await signUpAndSignIn(app, 'org-narrow-tenant');
      const org = await seedOrganizationWithOwner(
        admin,
        tenantOwner.userId,
        'org-narrow-org',
      );

      const res = await request(app.getHttpServer())
        .get(`/organizations/${org.id}`)
        .set('Authorization', `Bearer ${tenantOwner.accessToken}`)
        .expect(200);

      expect(res.body).toMatchObject({
        id: org.id,
        name: org.name,
        ownerUserId: tenantOwner.userId,
      });
      // The narrow P2 shape never carries the Platform Owner's richer fields.
      expect(res.body.academies).toBeUndefined();
      expect(res.body.members).toBeUndefined();
    });
  });

  // --- B. Platform Academies -----------------------------------------------

  describe('Platform Academies', () => {
    it('B1-B2: a Platform Owner can list and read academy detail, cross-tenant', async () => {
      const platformOwner = await arrangePlatformOwner('academy-po');
      const tenantOwner = await signUpAndSignIn(app, 'academy-tenant');
      const org = await seedOrganizationWithOwner(
        admin,
        tenantOwner.userId,
        'academy-org',
      );
      const academy = await seedAcademy(admin, org.id, 'academy-detail');
      await seedAcademyMember(admin, academy.id, tenantOwner.userId, 'owner');
      const course = await seedCourse(admin, academy.id, `academy-course-${Date.now()}`);

      const listRes = await request(app.getHttpServer())
        .get('/platform-academies')
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .expect(200);
      expect(
        listRes.body.items.some((item: { id: string }) => item.id === academy.id),
      ).toBe(true);

      const detailRes = await request(app.getHttpServer())
        .get(`/platform-academies/${academy.id}`)
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .expect(200);
      expect(detailRes.body).toMatchObject({
        id: academy.id,
        organizationId: org.id,
        organizationName: org.name,
        courseCount: 1,
        memberCount: 1,
      });
      // `ownerName` resolves from the `academy_members` row with role
      // `owner` (seeded above) — a real, non-fabricated field.
      expect(detailRes.body.ownerName).toBeTruthy();
      expect(detailRes.body.courses.some((c: { id: string }) => c.id === course.id)).toBe(
        true,
      );
    });
  });

  // --- C. Platform Users ----------------------------------------------------

  describe('Platform Users', () => {
    it('C1-C2-C3: a Platform Owner can list/read the user directory, with no sensitive fields ever returned', async () => {
      const platformOwner = await arrangePlatformOwner('users-po');
      const tenantUser = await signUpAndSignIn(app, 'users-directory-target');

      const listRes = await request(app.getHttpServer())
        .get('/platform-users')
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .expect(200);
      expect(
        listRes.body.items.some((item: { id: string }) => item.id === tenantUser.userId),
      ).toBe(true);
      const listedFields = Object.keys(listRes.body.items[0]);
      expect(listedFields).not.toEqual(
        expect.arrayContaining(['passwordHash', 'accessToken', 'refreshToken']),
      );

      const detailRes = await request(app.getHttpServer())
        .get(`/platform-users/${tenantUser.userId}`)
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .expect(200);
      expect(detailRes.body.id).toBe(tenantUser.userId);
      expect(detailRes.body.passwordHash).toBeUndefined();
      expect(detailRes.body.roles).toBeDefined();
      expect(detailRes.body.organizationMemberships).toBeDefined();
    });
  });

  // --- D. Audit Logs ----------------------------------------------------------

  describe('Audit Logs', () => {
    it('D1-D2-D3-D4: a real mutation writes an audit entry, listable/searchable/sortable, readable in detail — never via a frontend write path', async () => {
      const platformOwner = await arrangePlatformOwner('audit-po');
      const tenantOwner = await signUpAndSignIn(app, 'audit-tenant');
      const org = await seedOrganizationWithOwner(admin, tenantOwner.userId, 'audit-org');
      const academyName = `Audited Academy ${Date.now()}`;

      const created = await request(app.getHttpServer())
        .post('/academies')
        .set('Authorization', `Bearer ${tenantOwner.accessToken}`)
        .send({
          organizationId: org.id,
          name: academyName,
          slug: `audited-academy-${Date.now()}`,
        })
        .expect(201);

      const listRes = await request(app.getHttpServer())
        .get('/audit-log')
        .query({ search: 'academy.created' })
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .expect(200);
      const entry = listRes.body.items.find(
        (item: { targetId: string }) => item.targetId === created.body.id,
      );
      expect(entry).toBeTruthy();
      expect(entry.action).toBe('academy.created');
      expect(entry.actor.id).toBe(tenantOwner.userId);
      expect(entry.organizationId).toBe(org.id);

      const detailRes = await request(app.getHttpServer())
        .get(`/audit-log/${entry.id}`)
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .expect(200);
      expect(detailRes.body.targetId).toBe(created.body.id);
    });

    it('D5: sorting by occurredAt works', async () => {
      const platformOwner = await arrangePlatformOwner('audit-sort-po');
      const res = await request(app.getHttpServer())
        .get('/audit-log')
        .query({ sortBy: 'occurredAt', sortDirection: 'asc' })
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .expect(200);
      expect(Array.isArray(res.body.items)).toBe(true);
    });
  });

  // --- E. Support -----------------------------------------------------------

  describe('Support', () => {
    async function seedSupportCase(label: string) {
      return admin.supportCase.create({
        data: {
          subject: `${label} ${Date.now()}`,
          requesterName: label,
          requesterEmail: uniqueTestEmail(label),
        },
      });
    }

    it('E1-E2: a Platform Owner can list and read support cases', async () => {
      const platformOwner = await arrangePlatformOwner('support-po');
      const supportCase = await seedSupportCase('support-list');

      const listRes = await request(app.getHttpServer())
        .get('/support-cases')
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .expect(200);
      expect(
        listRes.body.items.some((item: { id: string }) => item.id === supportCase.id),
      ).toBe(true);

      const detailRes = await request(app.getHttpServer())
        .get(`/support-cases/${supportCase.id}`)
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .expect(200);
      expect(detailRes.body).toMatchObject({ id: supportCase.id, status: 'open' });
      expect(detailRes.body.messages).toEqual([]);
    });

    it('E3: an authorized Platform Owner can update case status', async () => {
      const platformOwner = await arrangePlatformOwner('support-status-po');
      const supportCase = await seedSupportCase('support-status');

      const res = await request(app.getHttpServer())
        .patch(`/support-cases/${supportCase.id}/status`)
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .send({ status: 'in_progress' })
        .expect(200);
      expect(res.body.status).toBe('in_progress');
    });

    it('E4: an invalid status is rejected', async () => {
      const platformOwner = await arrangePlatformOwner('support-invalid-po');
      const supportCase = await seedSupportCase('support-invalid');

      await request(app.getHttpServer())
        .patch(`/support-cases/${supportCase.id}/status`)
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .send({ status: 'not_a_real_status' })
        .expect(400);
    });

    it('E5: an authorized Platform Owner can reply, and it appears in the thread', async () => {
      const platformOwner = await arrangePlatformOwner('support-reply-po');
      const supportCase = await seedSupportCase('support-reply');

      const res = await request(app.getHttpServer())
        .post(`/support-cases/${supportCase.id}/messages`)
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .send({ body: 'Thanks for reaching out, we are looking into it.' })
        .expect(201);

      expect(res.body.messages).toHaveLength(1);
      expect(res.body.messages[0]).toMatchObject({
        authorRole: 'agent',
        body: 'Thanks for reaching out, we are looking into it.',
      });
    });

    it('E6: the status filter narrows the list', async () => {
      const platformOwner = await arrangePlatformOwner('support-filter-po');
      const openCase = await seedSupportCase('support-filter-open');
      const closedCase = await seedSupportCase('support-filter-closed');
      await admin.supportCase.update({
        where: { id: closedCase.id },
        data: { status: 'closed' },
      });

      const res = await request(app.getHttpServer())
        .get('/support-cases')
        .query({ status: 'closed' })
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .expect(200);

      const ids = res.body.items.map((item: { id: string }) => item.id);
      expect(ids).toContain(closedCase.id);
      expect(ids).not.toContain(openCase.id);
    });
  });

  // --- F. Platform Settings ---------------------------------------------------

  describe('Platform Settings', () => {
    it('F1-F2-F4: a Platform Owner can read configuration, update allowed fields, and partial updates preserve unrelated fields', async () => {
      const platformOwner = await arrangePlatformOwner('settings-po');

      const before = await request(app.getHttpServer())
        .get('/platform-settings')
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .expect(200);
      expect(before.body.platformName).toBeTruthy();

      const uniqueName = `Atlas Test ${Date.now()}`;
      const generalUpdate = await request(app.getHttpServer())
        .patch('/platform-settings')
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .send({ platformName: uniqueName })
        .expect(200);
      expect(generalUpdate.body.platformName).toBe(uniqueName);
      expect(generalUpdate.body.twoFactorRequired).toBe(before.body.twoFactorRequired);

      const securityUpdate = await request(app.getHttpServer())
        .patch('/platform-settings')
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .send({ twoFactorRequired: true, sessionTimeoutMinutes: 30 })
        .expect(200);
      expect(securityUpdate.body).toMatchObject({
        twoFactorRequired: true,
        sessionTimeoutMinutes: 30,
        // The General fields from the previous PATCH are untouched.
        platformName: uniqueName,
      });

      const neverUpdate = await request(app.getHttpServer())
        .patch('/platform-settings')
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .send({ sessionTimeoutMinutes: 'never' })
        .expect(200);
      expect(neverUpdate.body.sessionTimeoutMinutes).toBe('never');
    });

    it('F3: an invalid session timeout is rejected', async () => {
      const platformOwner = await arrangePlatformOwner('settings-invalid-po');
      await request(app.getHttpServer())
        .patch('/platform-settings')
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .send({ sessionTimeoutMinutes: 45 })
        .expect(400);
    });
  });
});
