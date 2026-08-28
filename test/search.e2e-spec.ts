/**
 * Global Search — permission-security e2e suite (Phase P17, master plan
 * §21/§15). The single most important property this suite proves:
 *
 *   IF user.role != platform_owner THEN `platform`/`users`-category
 *   search results MUST NEVER appear — enforced server-side, not by the
 *   frontend's `filterSearchResultsByRole` (documented there as
 *   defense-in-depth only).
 *
 * Also proves tenant isolation for the `content` category (a user in
 * Organization A must never discover Organization B's course names via
 * search) and that query validation/response shape match the real
 * frontend contract.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedCourse,
  seedOrganizationWithOwner,
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

function uniqueToken(label: string): string {
  return `${label}${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}

describe('Global Search — P17 (e2e)', () => {
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

  // --- Query validation ----------------------------------------------------

  describe('Query validation', () => {
    it('S1: rejects a missing q', async () => {
      const user = await signUpAndSignIn(app, 'search-val-missing');
      await request(app.getHttpServer())
        .get('/search')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(400);
    });

    it('S2: rejects an empty q', async () => {
      const user = await signUpAndSignIn(app, 'search-val-empty');
      await request(app.getHttpServer())
        .get('/search')
        .query({ q: '' })
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(400);
    });

    it('S3: rejects a whitespace-only q', async () => {
      const user = await signUpAndSignIn(app, 'search-val-ws');
      await request(app.getHttpServer())
        .get('/search')
        .query({ q: '   ' })
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(400);
    });

    it('S4: rejects an excessively long q', async () => {
      const user = await signUpAndSignIn(app, 'search-val-long');
      await request(app.getHttpServer())
        .get('/search')
        .query({ q: 'a'.repeat(500) })
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(400);
    });

    it('S5: unauthenticated callers cannot reach /search', async () => {
      await request(app.getHttpServer())
        .get('/search')
        .query({ q: 'academy' })
        .expect(401);
    });

    it('S6: an unknown query parameter (e.g. attempting to inject a category/role) is rejected, never silently ignored', async () => {
      const user = await signUpAndSignIn(app, 'search-val-extra');
      await request(app.getHttpServer())
        .get('/search')
        .query({ q: 'academy', category: 'platform', role: 'platform_owner' })
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(400);
    });
  });

  // --- Platform-category security (the critical rule) -----------------------

  describe('Platform-category security', () => {
    it('S7: Platform Owner receives platform-category results for a matching organization', async () => {
      const owner = await signUpAndSignIn(app, 'search-po');
      await makePlatformOwner(admin, owner.userId);
      const tenantOwner = await signUpAndSignIn(app, 'search-po-tenant');
      const token = uniqueToken('poplatform');
      await seedOrganizationWithOwner(admin, tenantOwner.userId, `Org-${token}`);

      const res = await request(app.getHttpServer())
        .get('/search')
        .query({ q: token })
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      const platformGroup = res.body.groups.find(
        (g: { category: string }) => g.category === 'platform',
      );
      expect(platformGroup).toBeDefined();
      expect(platformGroup.items.length).toBeGreaterThan(0);
    });

    it('S8: a normal Organization/Academy user NEVER receives platform-category results, even for a real, matching organization name', async () => {
      const tenantUser = await signUpAndSignIn(app, 'search-nonowner');
      const token = uniqueToken('nonownerplatform');
      await seedOrganizationWithOwner(admin, tenantUser.userId, `Org-${token}`);

      const res = await request(app.getHttpServer())
        .get('/search')
        .query({ q: token })
        .set('Authorization', `Bearer ${tenantUser.accessToken}`)
        .expect(200);

      expect(
        res.body.groups.some((g: { category: string }) => g.category === 'platform'),
      ).toBe(false);
    });

    it('S9: a student (no organization/academy role anywhere) NEVER receives platform-category results', async () => {
      const student = await signUpAndSignIn(app, 'search-student');
      const tenantOwner = await signUpAndSignIn(app, 'search-student-tenant');
      const token = uniqueToken('studentplatform');
      await seedOrganizationWithOwner(admin, tenantOwner.userId, `Org-${token}`);

      const res = await request(app.getHttpServer())
        .get('/search')
        .query({ q: token })
        .set('Authorization', `Bearer ${student.accessToken}`)
        .expect(200);

      expect(
        res.body.groups.some((g: { category: string }) => g.category === 'platform'),
      ).toBe(false);
    });

    it('S10: Platform Owner receives users-category results; a normal user never does', async () => {
      const owner = await signUpAndSignIn(app, 'search-userscat-po');
      await makePlatformOwner(admin, owner.userId);
      const token = uniqueToken('UsersCat');
      const target = await signUpAndSignIn(app, `search-${token}`);

      const asOwner = await request(app.getHttpServer())
        .get('/search')
        .query({ q: token })
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(
        asOwner.body.groups.some((g: { category: string }) => g.category === 'users'),
      ).toBe(true);

      const nonOwner = await signUpAndSignIn(app, 'search-userscat-non');
      const asNonOwner = await request(app.getHttpServer())
        .get('/search')
        .query({ q: token })
        .set('Authorization', `Bearer ${nonOwner.accessToken}`)
        .expect(200);
      expect(
        asNonOwner.body.groups.some((g: { category: string }) => g.category === 'users'),
      ).toBe(false);
      // Sanity — the target user genuinely exists and matches (proves this
      // isn't merely "no data to find").
      void target;
    });
  });

  // --- Tenant isolation (content category) -----------------------------------

  describe('Tenant isolation', () => {
    it('S11: a user only sees their own Organization’s courses in the content category, never another tenant’s', async () => {
      const userA = await signUpAndSignIn(app, 'search-tenantA');
      const orgA = await seedOrganizationWithOwner(admin, userA.userId, 'search-org-a');
      const academyA = await seedAcademy(admin, orgA.id, 'search-academy-a');
      const token = uniqueToken('TenantIsolation');
      await seedCourse(admin, academyA.id, `${token} in Org A`, {
        status: 'published',
        visibility: 'public',
      });

      const userB = await signUpAndSignIn(app, 'search-tenantB');
      const orgB = await seedOrganizationWithOwner(admin, userB.userId, 'search-org-b');
      const academyB = await seedAcademy(admin, orgB.id, 'search-academy-b');
      await seedCourse(admin, academyB.id, `${token} in Org B`, {
        status: 'published',
        visibility: 'public',
      });

      const resA = await request(app.getHttpServer())
        .get('/search')
        .query({ q: token })
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .expect(200);
      const contentA = resA.body.groups.find(
        (g: { category: string }) => g.category === 'content',
      );
      expect(contentA).toBeDefined();
      expect(
        contentA.items.every((i: { title: string }) => i.title.includes('Org A')),
      ).toBe(true);
      expect(
        contentA.items.some((i: { title: string }) => i.title.includes('Org B')),
      ).toBe(false);
    });

    it('S12: a student with no organization membership at all gets zero content results, not an error', async () => {
      const student = await signUpAndSignIn(app, 'search-nomembership');
      const res = await request(app.getHttpServer())
        .get('/search')
        .query({ q: 'anything' })
        .set('Authorization', `Bearer ${student.accessToken}`)
        .expect(200);
      expect(
        res.body.groups.find((g: { category: string }) => g.category === 'content'),
      ).toBeUndefined();
    });

    it('S13: a draft (unpublished) course never appears in search results for anyone', async () => {
      const user = await signUpAndSignIn(app, 'search-draft');
      const org = await seedOrganizationWithOwner(admin, user.userId, 'search-draft-org');
      const academy = await seedAcademy(admin, org.id, 'search-draft-academy');
      const token = uniqueToken('DraftCourse');
      await seedCourse(admin, academy.id, `${token} draft course`, { status: 'draft' });

      const res = await request(app.getHttpServer())
        .get('/search')
        .query({ q: token })
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
      const content = res.body.groups.find(
        (g: { category: string }) => g.category === 'content',
      );
      expect(content).toBeUndefined();
    });
  });

  // --- Response shape ------------------------------------------------------

  describe('Response shape', () => {
    it('S14: every group category is one of the four real SearchResultCategory values', async () => {
      const owner = await signUpAndSignIn(app, 'search-shape-po');
      await makePlatformOwner(admin, owner.userId);
      const res = await request(app.getHttpServer())
        .get('/search')
        .query({ q: 'settings' })
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      for (const group of res.body.groups) {
        expect(['users', 'platform', 'content', 'system']).toContain(group.category);
      }
    });

    it('S15: search results never expose internal/sensitive fields (password hash, email on non-users items, raw ids beyond what navigation needs)', async () => {
      const owner = await signUpAndSignIn(app, 'search-shape-safety-po');
      await makePlatformOwner(admin, owner.userId);
      const token = uniqueToken('SafetyCheck');
      const tenantOwner = await signUpAndSignIn(app, 'search-safety-tenant');
      await seedOrganizationWithOwner(admin, tenantOwner.userId, `Org-${token}`);

      const res = await request(app.getHttpServer())
        .get('/search')
        .query({ q: token })
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      const raw = JSON.stringify(res.body);
      expect(raw).not.toMatch(/passwordHash|password_hash/i);
      const allowedKeys = new Set([
        'id',
        'category',
        'title',
        'description',
        'metadata',
        'path',
      ]);
      for (const group of res.body.groups) {
        for (const item of group.items) {
          for (const key of Object.keys(item)) {
            expect(allowedKeys.has(key)).toBe(true);
          }
        }
      }
    });

    it('S16: the system category is available to every authenticated user, filtered to non-Platform-Owner pages', async () => {
      const user = await signUpAndSignIn(app, 'search-system');
      const res = await request(app.getHttpServer())
        .get('/search')
        .query({ q: 'settings' })
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);

      const systemGroup = res.body.groups.find(
        (g: { category: string }) => g.category === 'system',
      );
      expect(systemGroup).toBeDefined();
      expect(
        systemGroup.items.some((i: { path: string }) => i.path === '/dashboard/settings'),
      ).toBe(true);
    });

    it('S17: a non-Platform-Owner never receives a Platform-only system page (e.g. Platform Organizations) even when searching its exact name', async () => {
      const user = await signUpAndSignIn(app, 'search-system-restricted');
      const res = await request(app.getHttpServer())
        .get('/search')
        .query({ q: 'organizations' })
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);

      const systemGroup = res.body.groups.find(
        (g: { category: string }) => g.category === 'system',
      );
      const items = systemGroup?.items ?? [];
      expect(
        items.some(
          (i: { path: string }) => i.path === '/dashboard/platform/organizations',
        ),
      ).toBe(false);
    });
  });
});
