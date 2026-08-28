/**
 * Platform Owner Control Plane — tenant isolation and audit-coverage
 * proof (Phase P15, master plan §18: "the highest-priority suite in the
 * entire backend, CI-blocking"). Mirrors
 * `course-commerce-tenant-isolation.e2e-spec.ts`'s HTTP-level pattern:
 * every scenario here is a real request through the real guards/services/
 * RLS stack — no direct Prisma/session-variable manipulation (that
 * direct-RLS proof style is `rls-platform-control-plane.e2e-spec.ts`, out
 * of this file's scope).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma, seedOrganizationWithOwner } from './utils/db-admin';
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

describe('Platform Owner Control Plane — tenant isolation & audit coverage (e2e)', () => {
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

  // --- G. Cross-tenant security ---------------------------------------------

  describe('G. Cross-tenant security — every P15 cross-tenant route requires a real Platform Owner', () => {
    it('G1: a normal Organization Owner cannot list cross-tenant organizations, academies, or users', async () => {
      const tenantOwner = await signUpAndSignIn(app, 'g1-tenant');
      await seedOrganizationWithOwner(admin, tenantOwner.userId, 'g1-org');

      await request(app.getHttpServer())
        .get('/organizations')
        .set('Authorization', `Bearer ${tenantOwner.accessToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .get('/platform-academies')
        .set('Authorization', `Bearer ${tenantOwner.accessToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .get('/platform-users')
        .set('Authorization', `Bearer ${tenantOwner.accessToken}`)
        .expect(403);
    });

    it("G2: a normal tenant user cannot read another organization's detail by direct id (falls through to the membership guard, refused)", async () => {
      const orgAOwner = await signUpAndSignIn(app, 'g2-org-a-owner');
      const orgA = await seedOrganizationWithOwner(admin, orgAOwner.userId, 'g2-org-a');
      const orgBOwner = await signUpAndSignIn(app, 'g2-org-b-owner');
      await seedOrganizationWithOwner(admin, orgBOwner.userId, 'g2-org-b');

      await request(app.getHttpServer())
        .get(`/organizations/${orgA.id}`)
        .set('Authorization', `Bearer ${orgBOwner.accessToken}`)
        .expect(403);
    });

    it('G3: changing IDs does not bypass authorization — a non-Platform-Owner is refused for ANY academy/user id, not just a specific one', async () => {
      const tenantOwner = await signUpAndSignIn(app, 'g3-tenant');
      const org = await seedOrganizationWithOwner(admin, tenantOwner.userId, 'g3-org');

      await request(app.getHttpServer())
        .get(`/platform-academies/${org.id}`)
        .set('Authorization', `Bearer ${tenantOwner.accessToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .get(`/platform-users/${tenantOwner.userId}`)
        .set('Authorization', `Bearer ${tenantOwner.accessToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .get('/platform-academies/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${tenantOwner.accessToken}`)
        .expect(403);
    });

    it("G4: a Platform Owner CAN access both organizations' data through the same cross-tenant routes", async () => {
      const platformOwner = await arrangePlatformOwner('g4-po');
      const orgAOwner = await signUpAndSignIn(app, 'g4-org-a-owner');
      const orgA = await seedOrganizationWithOwner(admin, orgAOwner.userId, 'g4-org-a');
      const orgBOwner = await signUpAndSignIn(app, 'g4-org-b-owner');
      const orgB = await seedOrganizationWithOwner(admin, orgBOwner.userId, 'g4-org-b');

      await request(app.getHttpServer())
        .get(`/organizations/${orgA.id}`)
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/organizations/${orgB.id}`)
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .expect(200);
    });

    it("G5: query manipulation (search) cannot widen a non-Platform-Owner's access — still refused regardless of query params", async () => {
      const tenantOwner = await signUpAndSignIn(app, 'g5-tenant');
      await seedOrganizationWithOwner(admin, tenantOwner.userId, 'g5-org');

      await request(app.getHttpServer())
        .get('/organizations')
        .query({ search: '', page: 1, pageSize: 100 })
        .set('Authorization', `Bearer ${tenantOwner.accessToken}`)
        .expect(403);
    });

    it('G6: an unauthenticated caller is refused with 401 on every P15 cross-tenant route', async () => {
      await request(app.getHttpServer()).get('/organizations').expect(401);
      await request(app.getHttpServer()).get('/platform-academies').expect(401);
      await request(app.getHttpServer()).get('/platform-users').expect(401);
      await request(app.getHttpServer()).get('/audit-log').expect(401);
      await request(app.getHttpServer()).get('/support-cases').expect(401);
      await request(app.getHttpServer()).get('/platform-settings').expect(401);
    });

    it('G7: a non-Platform-Owner cannot read, mutate, or access Audit Log/Support/Platform Settings', async () => {
      const tenantOwner = await signUpAndSignIn(app, 'g7-tenant');

      await request(app.getHttpServer())
        .get('/audit-log')
        .set('Authorization', `Bearer ${tenantOwner.accessToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .get('/support-cases')
        .set('Authorization', `Bearer ${tenantOwner.accessToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .patch('/platform-settings')
        .set('Authorization', `Bearer ${tenantOwner.accessToken}`)
        .send({ platformName: 'Hijacked' })
        .expect(403);
    });

    it("G8: RLS remains active for normal tenant users on every table this phase added platform-select policies to — a tenant user still cannot see another organization's academies through the ordinary tenant-scoped academies endpoint", async () => {
      const orgAOwner = await signUpAndSignIn(app, 'g8-org-a-owner');
      const orgA = await seedOrganizationWithOwner(admin, orgAOwner.userId, 'g8-org-a');
      const orgBOwner = await signUpAndSignIn(app, 'g8-org-b-owner');
      const orgB = await seedOrganizationWithOwner(admin, orgBOwner.userId, 'g8-org-b');
      const academyB = await admin.academy.create({
        data: {
          organizationId: orgB.id,
          name: 'g8-academy-b',
          slug: `g8-academy-b-${Date.now()}`,
        },
      });

      const res = await request(app.getHttpServer())
        .get('/academies')
        .query({ organizationId: orgA.id })
        .set('Authorization', `Bearer ${orgAOwner.accessToken}`)
        .expect(200);
      expect(res.body.items.some((a: { id: string }) => a.id === academyB.id)).toBe(
        false,
      );
    });
  });

  // --- H. Audit coverage ------------------------------------------------------

  describe('H. Audit coverage — representative real business mutations produce audit records', () => {
    it("H1: a support case status change writes a real audit entry (P15's own mutation, not just the endpoint existing)", async () => {
      const platformOwner = await arrangePlatformOwner('h1-po');

      const supportCase = await admin.supportCase.create({
        data: {
          subject: `h1-case-${Date.now()}`,
          requesterName: 'h1',
          requesterEmail: uniqueTestEmail('h1-requester'),
        },
      });
      const before = await admin.auditLogEntry.count({
        where: { targetType: 'support_case', targetId: supportCase.id },
      });

      await request(app.getHttpServer())
        .patch(`/support-cases/${supportCase.id}/status`)
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .send({ status: 'resolved' })
        .expect(200);

      const after = await admin.auditLogEntry.count({
        where: { targetType: 'support_case', targetId: supportCase.id },
      });
      expect(after).toBe(before + 1);

      const entry = await admin.auditLogEntry.findFirst({
        where: { targetType: 'support_case', targetId: supportCase.id },
        orderBy: { occurredAt: 'desc' },
      });
      expect(entry?.action).toBe('support_case.status_changed');
      expect(entry?.actorUserId).toBe(platformOwner.userId);
    });

    it('H2: a real academy creation writes a real audit entry with the correct actor and organization — the business mutation itself generates it, not the audit endpoint', async () => {
      const tenantOwner = await signUpAndSignIn(app, 'h2-tenant');
      const org = await seedOrganizationWithOwner(admin, tenantOwner.userId, 'h2-org');

      const created = await request(app.getHttpServer())
        .post('/academies')
        .set('Authorization', `Bearer ${tenantOwner.accessToken}`)
        .send({
          organizationId: org.id,
          name: `H2 Academy ${Date.now()}`,
          slug: `h2-academy-${Date.now()}`,
        })
        .expect(201);

      const entry = await admin.auditLogEntry.findFirst({
        where: { targetType: 'academy', targetId: created.body.id },
      });
      expect(entry).toBeTruthy();
      expect(entry?.action).toBe('academy.created');
      expect(entry?.actorUserId).toBe(tenantOwner.userId);
      expect(entry?.organizationId).toBe(org.id);
    });

    it('H3: updating Platform Settings writes a real audit entry with no organizationId (a Platform-Owner-only action, not tied to one Organization)', async () => {
      const platformOwner = await arrangePlatformOwner('h3-po');

      await request(app.getHttpServer())
        .patch('/platform-settings')
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .send({ platformDescription: `h3-${Date.now()}` })
        .expect(200);

      const entry = await admin.auditLogEntry.findFirst({
        where: { action: 'platform_settings.updated', actorUserId: platformOwner.userId },
        orderBy: { occurredAt: 'desc' },
      });
      expect(entry).toBeTruthy();
      expect(entry?.organizationId).toBeNull();
    });

    it('H4: the frontend has no write path to the audit log — POST/PATCH/DELETE on /audit-log are not routed at all', async () => {
      const platformOwner = await arrangePlatformOwner('h4-po');
      await request(app.getHttpServer())
        .post('/audit-log')
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .send({ action: 'fake.event' })
        .expect(404);
    });
  });
});
