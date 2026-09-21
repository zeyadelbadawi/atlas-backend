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

  // --- Search index integrity — regression for migration p44 -----------------
  //
  // p44 (`20260922000000`) dropped the raw-SQL `search_vector` columns and
  // GIN indexes that `SearchRepository` queries; production answered every
  // search with `42703` from 13 Sep 2026 until P65 restored them as STORED
  // GENERATED columns that are ALSO modelled in `schema.prisma`. These tests
  // pin the schema facts a chain-built database must have, and the
  // behaviours those columns are supposed to deliver.

  describe('Search index integrity (p44 regression)', () => {
    it('S18: every searchable table carries a STORED GENERATED search_vector column and a GIN index on it', async () => {
      const columns = await admin.$queryRaw<
        { table_name: string; attgenerated: string; data_type: string }[]
      >`
        SELECT c.relname AS table_name, a.attgenerated::text AS attgenerated,
               format_type(a.atttypid, a.atttypmod) AS data_type
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND a.attname = 'search_vector' AND NOT a.attisdropped
        ORDER BY c.relname
      `;
      expect(columns.map((c) => c.table_name)).toEqual([
        'academies',
        'courses',
        'organizations',
        'users',
      ]);
      for (const c of columns) {
        expect(c.data_type).toBe('tsvector');
        expect(c.attgenerated).toBe('s');
      }

      const indexes = await admin.$queryRaw<{ tablename: string; indexdef: string }[]>`
        SELECT tablename, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname IN (
          'users_search_vector_idx', 'organizations_search_vector_idx',
          'academies_search_vector_idx', 'courses_search_vector_idx'
        )
        ORDER BY tablename
      `;
      expect(indexes.map((i) => i.tablename)).toEqual([
        'academies',
        'courses',
        'organizations',
        'users',
      ]);
      for (const i of indexes) {
        expect(i.indexdef).toMatch(/USING gin \(search_vector\)/);
      }
    });

    it('S19: the vector follows writes — renaming a course makes it findable by the new title and not the old one', async () => {
      const user = await signUpAndSignIn(app, 'search-follow');
      const org = await seedOrganizationWithOwner(
        admin,
        user.userId,
        'search-follow-org',
      );
      const academy = await seedAcademy(admin, org.id, 'search-follow-academy');
      const oldToken = uniqueToken('Oldname');
      const newToken = uniqueToken('Newname');
      const course = await seedCourse(admin, academy.id, `${oldToken} course`, {
        status: 'published',
        visibility: 'public',
      });

      const before = await request(app.getHttpServer())
        .get('/search')
        .query({ q: oldToken })
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
      expect(
        before.body.groups
          .find((g: { category: string }) => g.category === 'content')
          ?.items.some((i: { id: string }) => i.id === course.id),
      ).toBe(true);

      await admin.course.update({
        where: { id: course.id },
        data: { title: `${newToken} course` },
      });

      const staleQuery = await request(app.getHttpServer())
        .get('/search')
        .query({ q: oldToken })
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
      expect(
        staleQuery.body.groups.find(
          (g: { category: string }) => g.category === 'content',
        ),
      ).toBeUndefined();

      const freshQuery = await request(app.getHttpServer())
        .get('/search')
        .query({ q: newToken })
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
      expect(
        freshQuery.body.groups
          .find((g: { category: string }) => g.category === 'content')
          ?.items.some((i: { id: string }) => i.id === course.id),
      ).toBe(true);
    });

    it('S20: a description-only match is found, and a title match ranks above it', async () => {
      const user = await signUpAndSignIn(app, 'search-rank');
      const org = await seedOrganizationWithOwner(admin, user.userId, 'search-rank-org');
      const academy = await seedAcademy(admin, org.id, 'search-rank-academy');
      const token = uniqueToken('Ranktoken');
      const byDescription = await seedCourse(admin, academy.id, 'Plain title', {
        status: 'published',
        visibility: 'public',
      });
      await admin.course.update({
        where: { id: byDescription.id },
        data: { description: `A long description that mentions ${token} once.` },
      });
      const byTitle = await seedCourse(admin, academy.id, `${token} in the title`, {
        status: 'published',
        visibility: 'public',
      });

      const res = await request(app.getHttpServer())
        .get('/search')
        .query({ q: token })
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
      const items: { id: string }[] = res.body.groups.find(
        (g: { category: string }) => g.category === 'content',
      ).items;
      expect(items.map((i) => i.id)).toEqual([byTitle.id, byDescription.id]);
    });

    it('S21: the Platform Owner content search spans every tenant, while a tenant user still sees only their own', async () => {
      const owner = await signUpAndSignIn(app, 'search-span-po');
      await makePlatformOwner(admin, owner.userId);
      const token = uniqueToken('Spantoken');
      const userA = await signUpAndSignIn(app, 'search-span-a');
      const orgA = await seedOrganizationWithOwner(
        admin,
        userA.userId,
        'search-span-org-a',
      );
      const academyA = await seedAcademy(admin, orgA.id, 'search-span-academy-a');
      const courseA = await seedCourse(admin, academyA.id, `${token} A`, {
        status: 'published',
        visibility: 'private',
      });
      const userB = await signUpAndSignIn(app, 'search-span-b');
      const orgB = await seedOrganizationWithOwner(
        admin,
        userB.userId,
        'search-span-org-b',
      );
      const academyB = await seedAcademy(admin, orgB.id, 'search-span-academy-b');
      const courseB = await seedCourse(admin, academyB.id, `${token} B`, {
        status: 'published',
        visibility: 'private',
      });

      const asOwner = await request(app.getHttpServer())
        .get('/search')
        .query({ q: token })
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      const ownerIds = asOwner.body.groups
        .find((g: { category: string }) => g.category === 'content')
        .items.map((i: { id: string }) => i.id);
      expect(ownerIds).toEqual(expect.arrayContaining([courseA.id, courseB.id]));

      const asA = await request(app.getHttpServer())
        .get('/search')
        .query({ q: token })
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .expect(200);
      const aIds = asA.body.groups
        .find((g: { category: string }) => g.category === 'content')
        .items.map((i: { id: string }) => i.id);
      expect(aIds).toEqual([courseA.id]);
    });

    it('S22: a query that parses to nothing (stop words, bare operators) returns an empty result, never a 500', async () => {
      const owner = await signUpAndSignIn(app, 'search-stopwords');
      await makePlatformOwner(admin, owner.userId);
      for (const q of ['the', '- -', 'or', '""', 'and the']) {
        const res = await request(app.getHttpServer())
          .get('/search')
          .query({ q })
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .expect(200);
        expect(res.body.query).toBe(q.trim());
        for (const group of res.body.groups) {
          expect(['users', 'platform', 'content', 'system']).toContain(group.category);
        }
      }
    });

    it('S23: an archived course never appears in search, for its own tenant or the Platform Owner', async () => {
      const owner = await signUpAndSignIn(app, 'search-archived-po');
      await makePlatformOwner(admin, owner.userId);
      const user = await signUpAndSignIn(app, 'search-archived');
      const org = await seedOrganizationWithOwner(
        admin,
        user.userId,
        'search-archived-org',
      );
      const academy = await seedAcademy(admin, org.id, 'search-archived-academy');
      const token = uniqueToken('Archivedtoken');
      await seedCourse(admin, academy.id, `${token} archived`, {
        status: 'archived',
        visibility: 'public',
      });
      for (const caller of [user, owner]) {
        const res = await request(app.getHttpServer())
          .get('/search')
          .query({ q: token })
          .set('Authorization', `Bearer ${caller.accessToken}`)
          .expect(200);
        expect(
          res.body.groups.find((g: { category: string }) => g.category === 'content'),
        ).toBeUndefined();
      }
    });
    it('S24: the course candidate function refuses a caller who is not a member of the requested organization, and refuses a non-Platform-Owner cross-tenant search', async () => {
      const member = await signUpAndSignIn(app, 'search-fn-member');
      const org = await seedOrganizationWithOwner(admin, member.userId, 'search-fn-org');
      const academy = await seedAcademy(admin, org.id, 'search-fn-academy');
      const token = uniqueToken('Fntoken');
      const course = await seedCourse(admin, academy.id, `${token} course`, {
        status: 'published',
        visibility: 'public',
      });
      const outsider = await signUpAndSignIn(app, 'search-fn-outsider');
      const owner = await signUpAndSignIn(app, 'search-fn-po');
      await makePlatformOwner(admin, owner.userId);

      const call = (callerId: string, organizationId: string | null) =>
        admin.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM search_courses_candidates(${callerId}::text, ${organizationId}::text, ${token}::text, 5)
        `;

      expect((await call(member.userId, org.id)).map((r) => r.id)).toEqual([course.id]);
      expect(await call(outsider.userId, org.id)).toEqual([]);
      expect(await call(outsider.userId, null)).toEqual([]);
      expect(await call('', org.id)).toEqual([]);
      expect((await call(owner.userId, null)).map((r) => r.id)).toEqual([course.id]);
      expect((await call(owner.userId, org.id)).map((r) => r.id)).toEqual([course.id]);
    });

    it('S25: the organization and academy candidate functions serve only the Platform Owner, and never more than 50 rows', async () => {
      const owner = await signUpAndSignIn(app, 'search-fn2-po');
      await makePlatformOwner(admin, owner.userId);
      const tenantUser = await signUpAndSignIn(app, 'search-fn2-tenant');
      const token = uniqueToken('Fntwo');
      const org = await seedOrganizationWithOwner(
        admin,
        tenantUser.userId,
        `Org-${token}`,
      );
      const academy = await seedAcademy(admin, org.id, `Academy-${token}`);

      const orgs = (callerId: string, limit: number) =>
        admin.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM search_organizations_candidates(${callerId}::text, ${token}::text, ${limit}::integer)
        `;
      const academies = (callerId: string, limit: number) =>
        admin.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM search_academies_candidates(${callerId}::text, ${token}::text, ${limit}::integer)
        `;

      expect((await orgs(owner.userId, 5)).map((r) => r.id)).toEqual([org.id]);
      expect((await academies(owner.userId, 5)).map((r) => r.id)).toEqual([academy.id]);
      expect(await orgs(tenantUser.userId, 5)).toEqual([]);
      expect(await academies(tenantUser.userId, 5)).toEqual([]);
      expect(await orgs(owner.userId, 0)).toEqual([]);
      // The cap is enforced inside the function, whatever the caller asks for.
      const capped = await admin.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM search_organizations_candidates(${owner.userId}::text, 'org', 100000)
      `;
      expect(capped[0].n).toBeLessThanOrEqual(50);
    });
  });
});
